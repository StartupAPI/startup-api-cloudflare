import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './UserDO';
import { AccountDO } from './AccountDO';
import { SystemDO } from './SystemDO';
import { CookieManager } from './CookieManager';

const DEFAULT_USERS_PATH = '/users/';

export { UserDO, AccountDO, SystemDO };

import type { StartupAPIEnv } from './StartupAPIEnv';

export default {
  /**
   * Main Worker fetch handler.
   * Intercepts requests, serves static assets from `public/users` if applicable,
   * proxies requests to an origin URL, and injects a custom script into HTML responses.
   *
   * @param request - The incoming HTTP request.
   * @param env - The environment variables and bindings.
   * @param ctx - The execution context.
   * @returns A Promise resolving to the HTTP response.
   */
  async fetch(request: Request, env: StartupAPIEnv, ctx): Promise<Response> {
    // Prevent infinite loops when serving assets
    if (request.headers.has('x-skip-worker')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.ORIGIN_URL || !env.SESSION_SECRET) {
      return env.ASSETS.fetch(request);
    }

    const url = new URL(request.url);
    const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;

    const cookieManager = new CookieManager(env.SESSION_SECRET);

    // Handle OAuth Routes
    if (url.pathname.startsWith(usersPath + 'auth/')) {
      return handleAuth(request, env, url, usersPath, cookieManager);
    }

    if (url.pathname === usersPath + 'me/avatar') {
      return handleMeImage(request, env, 'avatar', cookieManager);
    }

    if (url.pathname === usersPath + 'me/provider-icon') {
      return handleMeImage(request, env, 'provider-icon', cookieManager);
    }

    // Handle API Routes
    if (url.pathname.startsWith(usersPath + 'api/')) {
      const apiPath = url.pathname.replace(usersPath + 'api/', '/');

      if (apiPath === '/me') {
        return handleMe(request, env, cookieManager);
      }

      if (apiPath === '/me/profile' && request.method === 'POST') {
        return handleUpdateProfile(request, env, cookieManager);
      }

      if (apiPath === '/stop-impersonation' && request.method === 'POST') {
        const cookieHeader = request.headers.get('Cookie');
        const cookies = parseCookies(cookieHeader || '');
        const backupSessionEncrypted = cookies['backup_session_id'];

        if (!backupSessionEncrypted) {
          return new Response('No impersonation session found', { status: 400 });
        }

        const backupSession = await cookieManager.decrypt(backupSessionEncrypted);
        if (!backupSession) {
          return new Response('Invalid backup session', { status: 400 });
        }

        const headers = new Headers();
        const newSessionIdEncrypted = await cookieManager.encrypt(backupSession);
        headers.set('Set-Cookie', `session_id=${newSessionIdEncrypted}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        headers.append('Set-Cookie', `backup_session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

        return Response.json({ success: true }, { headers });
      }

      if (apiPath === '/me/accounts') {
        return handleMyAccounts(request, env, cookieManager);
      }

      if (apiPath === '/me/accounts/switch' && request.method === 'POST') {
        return handleSwitchAccount(request, env, cookieManager);
      }
    }

    if (url.pathname === usersPath + 'logout') {
      return handleLogout(request, env, usersPath, cookieManager);
    }

    // Admin Routes
    if (url.pathname.startsWith(usersPath + 'admin/')) {
      return handleAdmin(request, env, usersPath, cookieManager);
    }

    // Intercept requests to usersPath and serve them from the public/users directory.
    // This allows us to serve our own scripts and assets.
    if (url.pathname.startsWith(usersPath)) {
      url.pathname = url.pathname.replace(usersPath, '/users/');
      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('x-skip-worker', 'true');
      return env.ASSETS.fetch(newRequest);
    }

    if (env.ORIGIN_URL) {
      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;

      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('Host', url.host);

      const response = await fetch(newRequest);

      const providers: string[] = [];
      if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
        providers.push('google');
      }
      if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
        providers.push('twitch');
      }

      return injectPowerStrip(response, usersPath, providers);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleAdmin(
  request: Request,
  env: StartupAPIEnv,
  usersPath: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user || !isAdmin(user, env)) {
    return new Response('Forbidden', { status: 403 });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(usersPath + 'admin', '');

  if (path === '/' || path === '') {
    url.pathname = '/users/admin/';
    const newRequest = new Request(url.toString(), request);
    newRequest.headers.set('x-skip-worker', 'true');
    return env.ASSETS.fetch(newRequest);
  }

  const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));

  if (path.startsWith('/api/')) {
    const apiPath = path.replace('/api/', '');
    if (apiPath.startsWith('users')) {
      return systemStub.fetch(new Request('http://do/' + apiPath + url.search, request));
    } else if (apiPath.startsWith('accounts')) {
      return systemStub.fetch(new Request('http://do/' + apiPath + url.search, request));
    } else if (apiPath === 'impersonate' && request.method === 'POST') {
      const { userId } = (await request.json()) as { userId: string };

      if (user.id === userId) {
        return new Response('Cannot impersonate yourself', { status: 400 });
      }

      // Get current session to backup
      const cookieHeader = request.headers.get('Cookie');
      const cookies = parseCookies(cookieHeader || '');
      const currentSessionEncrypted = cookies['session_id'];

      // Create a session for the target user
      const targetUserStub = env.USER.get(env.USER.idFromString(userId));
      const sessionRes = await targetUserStub.fetch('http://do/sessions', { method: 'POST' });
      const { sessionId } = (await sessionRes.json()) as any;

      const doId = userId;
      const sessionValue = `${sessionId}:${doId}`;
      const encryptedSession = await cookieManager.encrypt(sessionValue);

      const headers = new Headers();
      headers.set('Set-Cookie', `session_id=${encryptedSession}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      if (currentSessionEncrypted) {
        const decryptedCurrentSession = await cookieManager.decrypt(currentSessionEncrypted);
        if (decryptedCurrentSession) {
          const encryptedBackup = await cookieManager.encrypt(decryptedCurrentSession);
          headers.append('Set-Cookie', `backup_session_id=${encryptedBackup}; Path=/; HttpOnly; Secure; SameSite=Lax`);
        }
      }

      return Response.json({ success: true }, { headers });
    }
  }

  return new Response('Not Found', { status: 404 });
}

async function getUserFromSession(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
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
    const validateRes = await userStub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (!validateRes.ok) return null;

    const data = (await validateRes.json()) as any;
    if (data.valid) {
      return {
        id: doId,
        ...data.profile,
      };
    }
  } catch (e) {
    return null;
  }
  return null;
}

function isAdmin(user: any, env: StartupAPIEnv): boolean {
  if (!env.ADMIN_IDS) return false;
  const adminIds = env.ADMIN_IDS.split(',').map((e) => e.trim()).filter(Boolean);
  return (
    adminIds.includes(user.id) ||
    (user.email && adminIds.includes(user.email)) ||
    (user.subject_id && adminIds.includes(user.subject_id)) ||
    (user.provider && user.subject_id && adminIds.includes(`${user.provider}:${user.subject_id}`))
  );
}

async function handleMe(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];

  if (!sessionCookieEncrypted) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [sessionId, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const validateRes = await userStub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (!validateRes.ok) return validateRes;

    const data = (await validateRes.json()) as any;
    data.is_admin = isAdmin({ id: doId, ...data.profile }, env);
    data.is_impersonated = !!cookies['backup_session_id'];

    // Fetch memberships to find current account
    const membershipsRes = await userStub.fetch('http://do/memberships');
    const memberships = (await membershipsRes.json()) as any[];
    const currentMembership = memberships.find((m) => m.is_current) || memberships[0];

    if (currentMembership) {
      const accountId = env.ACCOUNT.idFromString(currentMembership.account_id);
      const accountStub = env.ACCOUNT.get(accountId);
      const accountInfoRes = await accountStub.fetch('http://do/info');
      if (accountInfoRes.ok) {
        data.account = await accountInfoRes.json();
        data.account.id = currentMembership.account_id;
        data.account.role = currentMembership.role;
      }
    }

    return Response.json(data);
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleUpdateProfile(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];

  if (!sessionCookieEncrypted) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [sessionId, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const validateRes = await userStub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (!validateRes.ok) return validateRes;

    const body = await request.text();
    return await userStub.fetch('http://do/profile', {
      method: 'POST',
      body,
    });
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleMeImage(
  request: Request,
  env: StartupAPIEnv,
  type: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];

  if (!sessionCookieEncrypted) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const stub = env.USER.get(id);
    return await stub.fetch(`http://do/images/${type}`);
  } catch (e) {
    return new Response('Error fetching image', { status: 500 });
  }
}

async function handleLogout(
  request: Request,
  env: StartupAPIEnv,
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
          await stub.fetch('http://do/sessions', {
            method: 'DELETE',
            body: JSON.stringify({ sessionId }),
          });
        } catch (e) {
          console.error('Error deleting session:', e);
          // Continue to clear cookie even if DO call fails
        }
      }
    }
  }

  const headers = new Headers();
  headers.set('Set-Cookie', 'session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  headers.set('Location', '/');
  return new Response(null, { status: 302, headers });
}

function parseCookies(cookieHeader: string): Record<string, string> {
  return cookieHeader.split(';').reduce(
    (acc, cookie) => {
      const [key, value] = cookie.split('=').map((c) => c.trim());
      if (key && value) acc[key] = value;
      return acc;
    },
    {} as Record<string, string>,
  );
}

async function handleMyAccounts(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];

  if (!sessionCookieEncrypted) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [sessionId, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const validateRes = await userStub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (!validateRes.ok) return validateRes;

    // Fetch memberships
    const membershipsRes = await userStub.fetch('http://do/memberships');
    const memberships = (await membershipsRes.json()) as any[];

    const accounts = await Promise.all(
      memberships.map(async (m) => {
        const accountId = env.ACCOUNT.idFromString(m.account_id);
        const accountStub = env.ACCOUNT.get(accountId);
        const infoRes = await accountStub.fetch('http://do/info');
        let info = {};
        if (infoRes.ok) {
          info = await infoRes.json();
        }
        return {
          ...info,
          ...m,
        };
      }),
    );

    return Response.json(accounts);
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleSwitchAccount(
  request: Request,
  env: StartupAPIEnv,
  cookieManager: CookieManager,
): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookieEncrypted = cookies['session_id'];

  if (!sessionCookieEncrypted) {
    return new Response('Unauthorized', { status: 401 });
  }

  const sessionCookie = await cookieManager.decrypt(sessionCookieEncrypted);
  if (!sessionCookie || !sessionCookie.includes(':')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [sessionId, doId] = sessionCookie.split(':');
  const { account_id } = (await request.json()) as { account_id: string };

  if (!account_id) {
    return new Response('Missing account_id', { status: 400 });
  }

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const validateRes = await userStub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });

    if (!validateRes.ok) return validateRes;

    const switchRes = await userStub.fetch('http://do/switch-account', {
      method: 'POST',
      body: JSON.stringify({ account_id }),
    });

    if (!switchRes.ok) {
      return switchRes;
    }

    return Response.json({ success: true });
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}
