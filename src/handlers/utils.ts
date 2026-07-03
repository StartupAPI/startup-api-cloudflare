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
  // atproto has no env credentials; it is enabled via factory config or the ATPROTO_ENABLED env flag.
  if (isAtprotoEnabled(providerConfigs.atproto, env)) {
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

/**
 * Build the `Set-Cookie` string for the encrypted `session_id`. A positive `ttlSeconds` makes it a
 * persistent cookie (survives browser restarts); pass 0 via the clear paths to expire it.
 */
export function sessionSetCookie(value: string, ttlSeconds: number): string {
  return `session_id=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;
}

export async function getUserFromSession(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
  ttlMs?: number,
): Promise<any> {
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
    const result = await userStub.validateSession(sessionId, ttlMs);
    if (result.valid) {
      const user: any = { id: doId, sessionId, profile: result.profile, credential: result.credential };
      // If the DO extended the session, surface enough to re-issue the persistent cookie on the response.
      if (result.renewedExpiresAt && ttlMs) {
        user.renew = { encryptedValue: sessionCookieEncrypted, ttlMs };
      }
      return user;
    }
  } catch (_e) {
    // ignore
  }
  return null;
}

/**
 * Re-issue the `session_id` cookie with a fresh `Max-Age` when the DO extended the session (sliding
 * renewal). The encrypted value is unchanged — only the cookie's lifetime is refreshed. Mirrors the
 * response-cloning shape of `checkAndClearStaleSession`.
 */
export function applySessionRenewal(response: Response, renew: { encryptedValue: string; ttlMs: number } | undefined): Response {
  if (!renew) return response;
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', sessionSetCookie(renew.encryptedValue, Math.floor(renew.ttlMs / 1000)));
  if (response.status === 301 || response.status === 302) {
    return new Response(null, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
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
      headers.set('Set-Cookie', sessionSetCookie('', 0));

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
