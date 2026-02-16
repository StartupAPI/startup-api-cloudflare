import type { StartupAPIEnv } from '../StartupAPIEnv';

import { GoogleProvider } from './GoogleProvider';
import { TwitchProvider } from './TwitchProvider';
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
  const authPath = usersPath + 'auth';

  const origin = env.AUTH_ORIGIN && env.AUTH_ORIGIN !== '' ? env.AUTH_ORIGIN : url.origin;
  const redirectBase = origin + authPath;

  // Instantiate providers
  const providers: (OAuthProvider | null)[] = [GoogleProvider.create(env, redirectBase), TwitchProvider.create(env, redirectBase)];

  const activeProviders = providers.filter((p): p is OAuthProvider => p !== null);

  // Handle Auth Start
  for (const provider of activeProviders) {
    if (provider.isMatch(path, authPath)) {
      const authUrl = provider.getAuthUrl(`state-${provider.name}`);
      return Response.redirect(authUrl, 302);
    }
  }

  // Handle Auth Callback
  for (const provider of activeProviders) {
    if (provider.isCallback(path, authPath)) {
      console.log(`[Auth] Callback received for ${provider.name}`);
      const code = url.searchParams.get('code');
      if (!code) return new Response('Missing code', { status: 400 });

      try {
        const token = await provider.getToken(code);
        const profile = await provider.getUserProfile(token.access_token);

        const credStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(provider.name));

        // 1. Try to resolve existing user by credential
        const resolveRes = await credStub.fetch(
          `http://do/resolve?subject_id=${profile.id}`,
        );

        let userIdStr: string | null = null;

        if (resolveRes.ok) {
          const resolveData = (await resolveRes.json()) as { user_id: string };
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
                userIdStr = sessionCookie.split(':')[1];
              }
            }
          }
        }

        const isNewUser = !userIdStr;
        const id = userIdStr ? env.USER.idFromString(userIdStr) : env.USER.newUniqueId();
        const stub = env.USER.get(id);
        userIdStr = id.toString();

        // Fetch and Store Avatar
        if (profile.picture) {
          try {
            const picRes = await fetch(profile.picture);
            if (picRes.ok) {
              const picBlob = await picRes.arrayBuffer();
              await stub.fetch('http://do/images/avatar', {
                method: 'PUT',
                headers: { 'Content-Type': picRes.headers.get('Content-Type') || 'image/jpeg' },
                body: picBlob,
              });
              // Update profile.picture to point to our worker
              profile.picture = usersPath + 'me/avatar';
            }
          } catch (e) {
            console.error('Failed to fetch avatar', e);
          }
        }

        // Store Provider Icon
        const providerSvg = provider.getIcon();

        if (providerSvg) {
          await stub.fetch('http://do/images/provider-icon', {
            method: 'PUT',
            headers: { 'Content-Type': 'image/svg+xml' },
            body: providerSvg,
          });
          (profile as any).provider_icon = usersPath + 'me/provider-icon';
        }

        // Register credential in provider-specific CredentialDO
        await credStub.fetch('http://do/', {
          method: 'PUT',
          body: JSON.stringify({
            user_id: userIdStr,
            provider: provider.name,
            subject_id: profile.id,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
            scope: token.scope,
            profile_data: profile,
          }),
        });

        // Register credential mapping in UserDO
        await stub.fetch('http://do/credentials', {
          method: 'POST',
          body: JSON.stringify({
            provider: provider.name,
            subject_id: profile.id,
          }),
        });

        // Register User in SystemDO index
        const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
        await systemStub.fetch('http://do/users', {
          method: 'POST',
          body: JSON.stringify({
            id: userIdStr,
            name: profile.name || userIdStr,
            email: profile.email,
            provider: provider.name,
          }),
        });

        // Ensure user has at least one account
        const membershipsRes = await stub.fetch('http://do/memberships');
        const memberships = (await membershipsRes.json()) as any[];

        if (memberships.length === 0) {
          // Create a personal account
          const accountId = env.ACCOUNT.newUniqueId();
          const accountStub = env.ACCOUNT.get(accountId);
          const accountIdStr = accountId.toString();

          // Initialize account info
          await accountStub.fetch('http://do/info', {
            method: 'POST',
            body: JSON.stringify({
              name: `${profile.name || userIdStr}'s Account`,
              personal: true,
            }),
          });

          // Register Account in SystemDO
          await systemStub.fetch('http://do/accounts', {
            method: 'POST',
            body: JSON.stringify({
              id: accountIdStr,
              name: `${profile.name || profile.id}'s Account`,
              status: 'active',
              plan: 'free',
            }),
          });

          // Add user as ADMIN to the account
          await accountStub.fetch('http://do/members', {
            method: 'POST',
            body: JSON.stringify({
              user_id: id.toString(),
              role: 1, // ADMIN
            }),
          });

          // Add membership to user
          await stub.fetch('http://do/memberships', {
            method: 'POST',
            body: JSON.stringify({
              account_id: accountIdStr,
              role: 1, // ADMIN
              is_current: true,
            }),
          });
        }

        // Create Session
        const sessionRes = await stub.fetch('http://do/sessions', { method: 'POST' });
        const session = (await sessionRes.json()) as any;

        // Set cookie and redirect
        const encryptedSession = await cookieManager.encrypt(`${session.sessionId}:${userIdStr}`);
        const headers = new Headers();
        headers.set('Set-Cookie', `session_id=${encryptedSession}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        headers.set('Location', !isNewUser ? usersPath + 'profile.html' : '/');

        return new Response(null, { status: 302, headers });
      } catch (e: any) {
        return new Response('Auth failed: ' + e.message, { status: 500 });
      }
    }
  }

  return new Response('Auth route not found', { status: 404 });
}
