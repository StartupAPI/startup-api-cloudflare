import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { isAtprotoEnabled } from '../auth/AtprotoProvider';
import type { ProviderConfigs } from '../auth/providers';

export function getActiveProviders(env: StartupAPIEnv, providerConfigs: ProviderConfigs = {}): string[] {
  const providers: string[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push('google');
  }
  if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
    providers.push('twitch');
  }
  if (env.PATREON_CLIENT_ID && env.PATREON_CLIENT_SECRET) {
    providers.push('patreon');
  }
  // atproto has no env credentials; it is enabled purely via factory config.
  if (isAtprotoEnabled(providerConfigs.atproto)) {
    providers.push('atproto');
  }
  return providers;
}

export function isAdmin(user: any, env: StartupAPIEnv): boolean {
  if (!env.ADMIN_IDS) return false;
  const adminIds = env.ADMIN_IDS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const userId = user.id;

  return (
    adminIds.includes(userId) ||
    (env.ENVIRONMENT === 'test' &&
      adminIds.some((id) => {
        try {
          return userId === env.USER.idFromName(id).toString();
        } catch (_e) {
          return false;
        }
      }))
  );
}

export function parseCookies(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce(
    (acc, cookie) => {
      const [key, value] = cookie.split('=').map((c) => c.trim());
      if (key && value) acc[key] = value;
      return acc;
    },
    {} as Record<string, string>,
  );
}

export async function getUserFromSession(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<any> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];
  if (!sessionCookieEncrypted) return null;

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) return null;

  const [sessionId, doId] = sessionCookie.split(':');
  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const result = await userStub.validateSession(sessionId);
    if (result.valid) return { id: doId, sessionId, profile: result.profile, credential: result.credential };
  } catch (_e) {
    // ignore
  }
  return null;
}

export async function checkAndClearStaleSession(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
  originalResponse: Response,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return originalResponse;

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];
  if (!sessionCookieEncrypted) return originalResponse;

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) return originalResponse;

  const [sessionId, doId] = sessionCookie.split(':');
  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);

    // If we are here, it means getUserFromSession already returned null.
    // We want to know IF it's because the user was deleted.
    const profile = await userStub.getProfile();
    if (Object.keys(profile).length === 0) {
      // User was deleted! Clear session in DO and remove cookie.
      await userStub.deleteSession(sessionId);

      const headers = new Headers(originalResponse.headers);
      headers.set('Set-Cookie', 'session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

      // If it was a redirect, we just update the headers
      if (originalResponse.status === 301 || originalResponse.status === 302) {
        return new Response(null, {
          status: originalResponse.status,
          headers,
        });
      }

      // Otherwise return new response with same body/status but updated headers
      return new Response(originalResponse.body, {
        status: originalResponse.status,
        headers,
      });
    }
  } catch (_e) {
    // ignore
  }

  return originalResponse;
}
