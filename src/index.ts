import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './UserDO';
import { AccountDO } from './AccountDO';

const DEFAULT_USERS_PATH = '/users/';

export { UserDO, AccountDO };

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

    const url = new URL(request.url);
    const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;

    // Handle OAuth Routes
    if (url.pathname.startsWith(usersPath + 'auth/')) {
      return handleAuth(request, env, url, usersPath);
    }

    if (url.pathname === usersPath + 'me') {
      return handleMe(request, env);
    }

    if (url.pathname === usersPath + 'me/avatar') {
      return handleMeImage(request, env, 'avatar');
    }

    if (url.pathname === usersPath + 'me/provider-icon') {
      return handleMeImage(request, env, 'provider-icon');
    }

    if (url.pathname === usersPath + 'me/accounts') {
      return handleMyAccounts(request, env);
    }

    if (url.pathname === usersPath + 'me/accounts/switch' && request.method === 'POST') {
      return handleSwitchAccount(request, env);
    }

    if (url.pathname === usersPath + 'logout') {
      return handleLogout(request, env, usersPath);
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

async function handleMe(request: Request, env: StartupAPIEnv): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookie = cookies['session_id'];

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

async function handleMeImage(request: Request, env: StartupAPIEnv, type: string): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookie = cookies['session_id'];

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

async function handleLogout(request: Request, env: StartupAPIEnv, usersPath: string): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    const sessionCookie = cookies['session_id'];

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

async function handleMyAccounts(request: Request, env: StartupAPIEnv): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookie = cookies['session_id'];

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
          ...m,
          ...info,
        };
      }),
    );

    return Response.json(accounts);
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleSwitchAccount(request: Request, env: StartupAPIEnv): Promise<Response> {
  const cookieHeader = request.headers.get('Cookie');
  if (!cookieHeader) return new Response('Unauthorized', { status: 401 });

  const cookies = parseCookies(cookieHeader);
  const sessionCookie = cookies['session_id'];

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
