import type { StartupAPIEnv } from '../StartupAPIEnv';

import { GoogleProvider } from './GoogleProvider';
import { TwitchProvider } from './TwitchProvider';
import { PatreonProvider } from './PatreonProvider';
import { OAuthProvider } from './OAuthProvider';
import { CookieManager } from '../CookieManager';

export async function handleAuth(
  request: Request,
  env: StartupAPIEnv,
  url: URL,
  usersPath: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const path = url.pathname;
  const origin = env.AUTH_ORIGIN && env.AUTH_ORIGIN !== '' ? env.AUTH_ORIGIN : url.origin;

  // Standardize redirectBase
  const baseUsersPath = usersPath.startsWith('/') ? usersPath : '/' + usersPath;
  const redirectBase = new URL((baseUsersPath.endsWith('/') ? baseUsersPath : baseUsersPath + '/') + 'auth', origin).toString();

  // For internal matching, we still need authPath
  const authPath = new URL(redirectBase).pathname;

  // Instantiate providers
  const providers: (OAuthProvider | null)[] = [
    GoogleProvider.create(env, redirectBase),
    TwitchProvider.create(env, redirectBase),
    PatreonProvider.create(env, redirectBase),
  ];

  const activeProviders = providers.filter((p): p is OAuthProvider => p !== null);

  // Handle Auth Start
  for (const provider of activeProviders) {
    if (provider.isMatch(path, authPath)) {
      const returnUrl = url.searchParams.get('return_url');
      const stateObj = {
        nonce: Math.random().toString(36).substring(2),
        return_url: returnUrl,
      };
      // Use robust base64 encoding for state
      const state = btoa(unescape(encodeURIComponent(JSON.stringify(stateObj))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      const authUrl = provider.getAuthUrl(state);
      return Response.redirect(authUrl, 302);
    }
  }

  // Handle Auth Callback
  for (const provider of activeProviders) {
    if (provider.isCallback(path, authPath)) {
      console.log(`[Auth] Callback received for ${provider.name}`);
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });

      const stateBase64 = url.searchParams.get('state');
      let returnUrl: string | null = null;
      if (stateBase64) {
        try {
          // Robust base64 decoding
          const base64 = stateBase64.replace(/-/g, '+').replace(/_/g, '/');
          const stateJson = decodeURIComponent(escape(atob(base64)));
          const stateObj = JSON.parse(stateJson);
          returnUrl = stateObj.return_url;
        } catch (e) {
          console.error('Failed to parse state', e);
        }
      }

      try {
        const token = await provider.getToken(code);
        const profile = await provider.getUserProfile(token.access_token);

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
      } catch (e) {
        return new Response(`Auth failed: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
      }
    }
  }

  return new Response('Auth route not found', { status: 404 });
}
