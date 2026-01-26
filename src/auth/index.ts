import type { StartupAPIEnv } from '../StartupAPIEnv';

import { GoogleProvider } from './GoogleProvider';
import { TwitchProvider } from './TwitchProvider';
import { OAuthProvider } from './OAuthProvider';

export async function handleAuth(request: Request, env: StartupAPIEnv, url: URL, usersPath: string): Promise<Response> {
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

        // Store in UserDO
        const id = env.USER.idFromName(provider.name + ':' + profile.id);
        const stub = env.USER.get(id);

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

        await stub.fetch('http://do/credentials', {
          method: 'POST',
          body: JSON.stringify({
            provider: provider.name,
            subject_id: profile.id,
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
            scope: token.scope,
            profile_data: profile,
          }),
        });

        // Create Session
        const sessionRes = await stub.fetch('http://do/sessions', { method: 'POST' });
        const session = (await sessionRes.json()) as any;

        // Set cookie and redirect home
        const doId = id.toString();
        const headers = new Headers();
        headers.set('Set-Cookie', `session_id=${session.sessionId}:${doId}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        headers.set('Location', '/');

        return new Response(null, { status: 302, headers });
      } catch (e: any) {
        return new Response('Auth failed: ' + e.message, { status: 500 });
      }
    }
  }

  return new Response('Auth route not found', { status: 404 });
}
