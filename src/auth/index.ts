import type { StartupAPIEnv } from '../StartupAPIEnv';

import { CookieManager } from '../CookieManager';
import { refreshEntitlements } from '../entitlements/service';
import { computeRedirectBase, createProviders } from './providers';
import type { ProviderConfigs } from './providers';
import type { AuthContext, ExchangeResult, OAuthProvider } from './OAuthProvider';

export async function handleAuth(
  request: Request,
  env: StartupAPIEnv,
  url: URL,
  usersPath: string,
  cookieManager: CookieManager,
  providerConfigs: ProviderConfigs = {},
): Promise<Response> {
  const path = url.pathname;
  const origin = env.AUTH_ORIGIN && env.AUTH_ORIGIN !== '' ? env.AUTH_ORIGIN : url.origin;

  // Standardize redirectBase
  const redirectBase = computeRedirectBase(env, origin, usersPath);

  // For internal matching, we still need authPath
  const authPath = new URL(redirectBase).pathname;

  // Instantiate active providers
  const activeProviders = createProviders(env, redirectBase, providerConfigs);

  const ctx: AuthContext = { request, env, url, redirectBase, authPath, usersPath, origin, cookieManager };

  // Provider-specific auxiliary routes (e.g. the atproto client-metadata document).
  for (const provider of activeProviders) {
    const res = await provider.handleExtraRoute(ctx);
    if (res) return res;
  }

  // Handle Auth Start
  for (const provider of activeProviders) {
    if (provider.isMatch(path, authPath)) {
      try {
        return await provider.authorize(ctx);
      } catch (e) {
        return new Response(`Auth failed: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
      }
    }
  }

  // Handle Auth Callback
  for (const provider of activeProviders) {
    if (provider.isCallback(path, authPath)) {
      console.log(`[Auth] Callback received for ${provider.name}`);
      try {
        const result = await provider.exchange(ctx);
        return await finishLogin(provider, result, ctx);
      } catch (e) {
        const status = (e as { status?: number })?.status ?? 500;
        return new Response(`Auth failed: ${e instanceof Error ? e.message : String(e)}`, { status });
      }
    }
  }

  return new Response('Auth route not found', { status: 404 });
}

/**
 * Shared post-exchange login finalization, provider-agnostic: resolve or create the user, link the
 * credential, fetch login-time entitlements, ensure a personal account exists, mint a session and set
 * the session cookie. `result.setCookies` lets a provider emit additional cookies (e.g. clearing
 * transient flow state).
 */
async function finishLogin(provider: OAuthProvider, result: ExchangeResult, ctx: AuthContext): Promise<Response> {
  const { env, request, usersPath, origin, cookieManager } = ctx;
  const { token, profile, returnUrl } = result;

  const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));

  // 1. Try to resolve existing user by credential
  const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(provider.name));
  const resolveData = await credentialStub.get(profile.id);

  let userIdStr: string | null = null;
  let staleSessionId: string | null = null;

  if (resolveData) {
    userIdStr = resolveData.user_id;
  } else {
    // 2. Not found, check if user is already logged in (to link account)
    const cookieHeader = request.headers.get('Cookie');
    if (cookieHeader) {
      const cookies = cookieHeader.split(';').reduce(
        (acc, cookie) => {
          const [key, value] = cookie.split('=').map((c) => c.trim());
          if (key && value) acc[key] = value;
          return acc;
        },
        {} as Record<string, string>,
      );
      const sessionCookieEncrypted = cookies['session_id'];
      if (sessionCookieEncrypted) {
        const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
        if (sessionCookie && sessionCookie.includes(':')) {
          const parts = sessionCookie.split(':');
          staleSessionId = parts[0];
          userIdStr = parts[1];
        }
      }
    }
  }

  if (userIdStr) {
    // Verify user still exists (has a profile)
    const userStub = env.USER.get(env.USER.idFromString(userIdStr));
    const profileData = await userStub.getProfile();
    if (Object.keys(profileData).length === 0) {
      // User was deleted!
      if (staleSessionId) {
        try {
          await userStub.deleteSession(staleSessionId);
        } catch (_e) {
          // ignore
        }
      }
      userIdStr = null;
    }
  }

  const isNewUser = !userIdStr;
  const id = userIdStr ? env.USER.idFromString(userIdStr) : env.USER.newUniqueId();
  const userStub = env.USER.get(id);
  userIdStr = id.toString();

  // Fetch and Store Avatar (Only for new users)
  if (isNewUser && profile.picture) {
    try {
      const picRes = await fetch(profile.picture);
      if (picRes.ok) {
        const picBlob = await picRes.arrayBuffer();
        await userStub.storeImage('avatar', picBlob, picRes.headers.get('Content-Type') || 'image/jpeg');
        // Update profile.picture to point to our worker
        profile.picture = usersPath + 'me/avatar';
      }
    } catch (e) {
      console.error('Failed to fetch avatar', e);
    }
  }

  // Register credential in provider-specific CredentialDO
  await credentialStub.put({
    user_id: userIdStr,
    subject_id: profile.id,
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
    scope: token.scope,
    profile_data: profile,
  });

  // Register credential mapping in UserDO
  await userStub.addCredential(provider.name, profile.id);

  // Login-time entitlement fetch: providers that support entitlements (e.g. Patreon) get an
  // initial entitlement snapshot now, so gating works even when no freshness mechanism is
  // configured. Best-effort — never block or fail login on an entitlement error.
  if (provider.supportsEntitlements()) {
    try {
      await refreshEntitlements(
        env,
        provider,
        {
          subject_id: profile.id,
          user_id: userIdStr,
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
          scope: typeof token.scope === 'string' ? token.scope : undefined,
          profile_data: profile,
        },
        'oauth',
      );
    } catch (e) {
      console.error('[auth] Login-time entitlement fetch failed', e);
    }
  }

  // Register User in SystemDO index (Only for new users)
  if (isNewUser) {
    await userStub.updateProfile(profile);
    await systemStub.registerUser({
      id: userIdStr,
      name: profile.name || userIdStr,
      email: profile.email,
      provider: provider.name,
    });
  }

  // Ensure user has at least one account
  const memberships = await userStub.getMemberships();

  if (memberships.length === 0) {
    // Create a personal account
    const accountId = env.ACCOUNT.newUniqueId();
    const accountStub = env.ACCOUNT.get(accountId);
    const accountIdStr = accountId.toString();

    // Initialize account info
    await accountStub.updateInfo({
      name: `${profile.name || userIdStr}'s Account`,
      personal: true,
    });

    // Register Account in SystemDO
    await systemStub.registerAccount({
      id: accountIdStr,
      name: `${profile.name || profile.id}'s Account`,
      status: 'active',
      plan: 'free',
    });

    // Add user as ADMIN to the account
    await accountStub.addMember(id.toString(), 1);

    // Add membership to user
    await userStub.addMembership(accountIdStr, 1, true);
  }

  // Create Session
  const session = await userStub.createSession({ provider: provider.name });

  // Set cookie and redirect
  const encryptedSession = await cookieManager.encrypt(`${session.sessionId}:${userIdStr}`);
  const headers = new Headers();
  headers.set('Set-Cookie', `session_id=${encryptedSession}; Path=/; HttpOnly; Secure; SameSite=Lax`);
  for (const cookie of result.setCookies ?? []) {
    headers.append('Set-Cookie', cookie);
  }

  let redirectUrl = !isNewUser ? usersPath + 'profile.html' : '/';
  if (returnUrl) {
    try {
      const parsedReturn = new URL(returnUrl, origin);
      if (parsedReturn.origin === origin) {
        redirectUrl = parsedReturn.toString();
      }
    } catch (_e) {
      if (returnUrl.startsWith('/')) {
        redirectUrl = returnUrl;
      }
    }
  }

  headers.set('Location', redirectUrl);
  return new Response(null, { status: 302, headers });
}
