import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { parseCookies } from './utils';

export async function handleLogout(
  request: Request,
  env: StartupAPIEnv,
  url: URL,
  usersPath: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const sessionCookieEncrypted = cookies['session_id'];

    if (sessionCookieEncrypted) {
      const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
      if (sessionCookie && sessionCookie.includes(':')) {
        const [sessionId, doId] = sessionCookie.split(':');
        try {
          const id = env.USER.idFromString(doId);
          const stub = env.USER.get(id);
          await stub.deleteSession(sessionId);
        } catch (_e) {
          console.error('Error deleting session:', _e);
          // Continue to clear cookie even if DO call fails
        }
      }
    }
  }

  const headers = new Headers();
  headers.set('Set-Cookie', 'session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  let redirectUrl = '/';
  const returnUrl = url.searchParams.get('return_url');
  if (returnUrl) {
    const origin = env.AUTH_ORIGIN && env.AUTH_ORIGIN !== '' ? env.AUTH_ORIGIN : url.origin;
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
