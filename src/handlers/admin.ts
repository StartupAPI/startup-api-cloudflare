import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { getUserFromSession, checkAndClearStaleSession, isAdmin, parseCookies, getActiveProviders, sessionSetCookie } from './utils';
import type { ProviderConfigs } from '../auth/providers';
import { DEFAULT_SESSION_TTL_MS } from '../schemas/config';
import { Plan } from '../billing/Plan';
import { UserProfileSchema } from '../schemas/user';
import { SystemAccountSchema, MemberSchema } from '../schemas/account';
import { ImpersonateSchema } from '../schemas/admin';

export async function handleAdmin(
  request: Request,
  env: StartupAPIEnv,
  usersPath: string,
  cookieManager: CookieManager,
  providerConfigs: ProviderConfigs = {},
  sessionTtlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user || !isAdmin(user, env)) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Forbidden', { status: 403 }));
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(usersPath + 'admin', '');

  if (path === '/' || path === '') {
    url.pathname = '/users/admin/';
    const newRequest = new Request(url.toString(), request);
    newRequest.headers.set('x-skip-worker', 'true');
    const response = await env.ASSETS.fetch(newRequest);
    if (!response.ok) return response;

    let html = await response.text();
    html = html.replace(/\{\{ssr:([a-z0-9_]+)\}\}/g, (match, key) => {
      const replacements: Record<string, string> = {
        plans_json: JSON.stringify(Plan.getAll()).replace(/"/g, '&quot;'),
        providers: getActiveProviders(env, providerConfigs).join(','),
      };
      return replacements[key] !== undefined ? replacements[key] : match;
    });

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));

  if (path.startsWith('/api/')) {
    try {
      const apiPath = path.replace('/api/', '');
      const parts = apiPath.split('/');

      if (parts[0] === 'users') {
        if (parts.length === 1 && request.method === 'GET') {
          return Response.json(await systemStub.listUsers(url.searchParams.get('q') || undefined));
        }
        if (parts.length === 2) {
          const userId = parts[1];
          if (request.method === 'GET') return Response.json(await systemStub.getUser(userId));
          if (request.method === 'DELETE') return Response.json(await systemStub.deleteUser(userId));
          if (request.method === 'PATCH' || request.method === 'PUT') {
            const data = await request.json();
            const validatedData = UserProfileSchema.partial().parse(data);
            return Response.json(await systemStub.updateUser(userId, validatedData));
          }
        }
        if (parts.length === 3 && parts[2] === 'memberships' && request.method === 'GET') {
          const userId = parts[1];
          return Response.json(await systemStub.getUserMemberships(userId));
        }
      } else if (parts[0] === 'accounts') {
        if (parts.length === 1) {
          if (request.method === 'GET') return Response.json(await systemStub.listAccounts(url.searchParams.get('q') || undefined));
          if (request.method === 'POST') {
            const data = await request.json();
            const validatedData = SystemAccountSchema.parse(data);
            return Response.json(await systemStub.registerAccount(validatedData));
          }
        }
        if (parts.length === 2) {
          const accountId = parts[1];
          if (request.method === 'GET') return Response.json(await systemStub.getAccount(accountId));
          if (request.method === 'PUT') {
            const data = await request.json();
            const validatedData = SystemAccountSchema.partial().parse(data);
            return Response.json(await systemStub.updateAccount(accountId, validatedData));
          }
          if (request.method === 'DELETE') return Response.json(await systemStub.deleteAccount(accountId));
        }
        if (parts.length >= 3 && parts[2] === 'members') {
          const accountId = parts[1];
          const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));
          if (parts.length === 3) {
            if (request.method === 'GET') return Response.json(await accountStub.getMembers());
            if (request.method === 'POST') {
              const data = await request.json();
              const { user_id, role } = MemberSchema.parse(data);
              return Response.json(await accountStub.addMember(user_id, role));
            }
          } else if (parts.length === 4 && request.method === 'DELETE') {
            return Response.json(await accountStub.removeMember(parts[3]));
          }
        }
      } else if (parts[0] === 'impersonate' && request.method === 'POST') {
        const body = await request.json();
        const data = ImpersonateSchema.parse(body);
        const user_id = data.user_id || data.userId;
        if (!user_id) return new Response('Missing user_id', { status: 400 });

        if (user_id === user.id) {
          return new Response('Cannot impersonate yourself', { status: 400 });
        }

        const userDOId = env.USER.idFromString(user_id);
        const userStub = env.USER.get(userDOId);
        const session = await userStub.createSession({ provider: 'admin-impersonation', impersonator: user.id }, sessionTtlMs);

        const cookieHeader = request.headers.get('Cookie');
        const cookies = parseCookies(cookieHeader || '');
        const currentSessionEncrypted = cookies['session_id'];

        const headers = new Headers();
        const newSessionIdEncrypted = await cookieManager.encrypt(`${session.sessionId}:${user_id}`);
        headers.set('Set-Cookie', sessionSetCookie(newSessionIdEncrypted, Math.floor(sessionTtlMs / 1000)));
        if (currentSessionEncrypted) {
          const backupSession = await cookieManager.decrypt(currentSessionEncrypted);
          if (backupSession) {
            const backupSessionEncrypted = await cookieManager.encrypt(backupSession);
            headers.append('Set-Cookie', `backup_session_id=${backupSessionEncrypted}; Path=/; HttpOnly; Secure; SameSite=Lax`);
          }
        }

        return Response.json({ success: true }, { headers });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
    }
  }

  url.pathname = '/users/admin' + path;
  const newRequest = new Request(url.toString(), request);
  newRequest.headers.set('x-skip-worker', 'true');
  return env.ASSETS.fetch(newRequest);
}
