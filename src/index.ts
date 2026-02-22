import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './UserDO';
import { AccountDO } from './AccountDO';
import { SystemDO } from './SystemDO';
import { CredentialDO } from './CredentialDO';
import { CookieManager } from './CookieManager';

const DEFAULT_USERS_PATH = '/users/';

export { UserDO, AccountDO, SystemDO, CredentialDO };

import type { StartupAPIEnv } from './StartupAPIEnv';

export default {
  /**
   * Main Worker fetch handler.
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

    // SSR Routes
    const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
    if (url.pathname.startsWith(usersPathNormalized)) {
      const subPath = url.pathname.slice(usersPathNormalized.length);
      const isProfile = subPath === 'profile.html' || subPath === 'profile';
      const isAccounts = subPath === 'accounts.html' || subPath === 'accounts';

      if (isProfile || isAccounts) {
        return handleSSR(request, env, url, usersPath, cookieManager);
      }
    }

    // Handle OAuth Routes
    if (url.pathname.startsWith(usersPath + 'auth/')) {
      return handleAuth(request, env, url, usersPath, cookieManager);
    }

    if (url.pathname === usersPath + 'me/avatar') {
      return handleMeImage(request, env, 'avatar', cookieManager);
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

      if (apiPath === '/me/credentials') {
        if (request.method === 'GET') {
          return handleListCredentials(request, env, cookieManager);
        } else if (request.method === 'DELETE') {
          return handleDeleteCredential(request, env, cookieManager);
        }
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

      if (apiPath.startsWith('/me/accounts/')) {
        const parts = apiPath.split('/');
        if (parts.length === 4) {
          return handleAccountDetails(request, env, parts[3], cookieManager);
        }
        if (parts.length === 5 && parts[4] === 'avatar') {
          return handleAccountImage(request, env, parts[3], 'avatar', cookieManager);
        }
        if (parts.length >= 5 && parts[4] === 'members') {
          return handleAccountMembers(request, env, parts[3], parts.slice(5), cookieManager);
        }
      }

      if (apiPath.startsWith('/users/') && apiPath.endsWith('/avatar')) {
        const parts = apiPath.split('/');
        if (parts.length === 4) {
          return handleUserImage(request, env, parts[2], 'avatar', cookieManager);
        }
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
      const providers = getActiveProviders(env);

      return injectPowerStrip(response, usersPath, providers);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<StartupAPIEnv>;

function getActiveProviders(env: StartupAPIEnv): string[] {
  const providers: string[] = [];
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.push('google');
  }
  if (env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET) {
    providers.push('twitch');
  }
  return providers;
}

async function handleAdmin(request: Request, env: StartupAPIEnv, usersPath: string, cookieManager: CookieManager): Promise<Response> {
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
    const response = await env.ASSETS.fetch(newRequest);
    if (!response.ok) return response;

    let html = await response.text();
    html = renderSSR(html, {
      providers: getActiveProviders(env).join(','),
    });

    return new Response(html, {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));

  if (path.startsWith('/api/')) {
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
      }
      if (parts.length === 3 && parts[2] === 'memberships' && request.method === 'GET') {
        const userId = parts[1];
        return Response.json(await systemStub.getUserMemberships(userId));
      }
    } else if (parts[0] === 'accounts') {
      if (parts.length === 1) {
        if (request.method === 'GET') return Response.json(await systemStub.listAccounts(url.searchParams.get('q') || undefined));
        if (request.method === 'POST') return Response.json(await systemStub.registerAccount(await request.json()));
      }
      if (parts.length === 2) {
        const accountId = parts[1];
        if (request.method === 'GET') return Response.json(await systemStub.getAccount(accountId));
        if (request.method === 'PUT') return Response.json(await systemStub.updateAccount(accountId, await request.json()));
        if (request.method === 'DELETE') return Response.json(await systemStub.deleteAccount(accountId));
      }
      if (parts.length >= 3 && parts[2] === 'members') {
        const accountId = parts[1];
        const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));
        if (parts.length === 3) {
          if (request.method === 'GET') return Response.json(await accountStub.getMembers());
          if (request.method === 'POST') {
            const data = (await request.json()) as any;
            return Response.json(await accountStub.addMember(data.user_id, data.role));
          }
        } else if (parts.length === 4 && request.method === 'DELETE') {
          return Response.json(await accountStub.removeMember(parts[3]));
        }
      }
    } else if (parts[0] === 'impersonate' && request.method === 'POST') {
      const data = (await request.json()) as any;
      const user_id = data.user_id || data.userId;
      if (!user_id) return new Response('Missing user_id', { status: 400 });

      if (user_id === user.id) {
        return new Response('Cannot impersonate yourself', { status: 400 });
      }

      const userDOId = env.USER.idFromString(user_id);
      const userStub = env.USER.get(userDOId);
      const session = await userStub.createSession({ provider: 'admin-impersonation', impersonator: user.id });

      const cookieHeader = request.headers.get('Cookie');
      const cookies = parseCookies(cookieHeader || '');
      const currentSessionEncrypted = cookies['session_id'];

      const headers = new Headers();
      const newSessionIdEncrypted = await cookieManager.encrypt(`${session.sessionId}:${user_id}`);
      headers.set('Set-Cookie', `session_id=${newSessionIdEncrypted}; Path=/; HttpOnly; Secure; SameSite=Lax`);
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
  }

  url.pathname = '/users/admin' + path;
  const newRequest = new Request(url.toString(), request);
  newRequest.headers.set('x-skip-worker', 'true');
  return env.ASSETS.fetch(newRequest);
}

async function handleMe(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { id: doId, profile: initialProfile, credential } = user;

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);

    const data: any = {
      valid: true,
      profile: { ...initialProfile },
      credential,
    };

    const image = await userStub.getImage('avatar');
    if (image) {
      const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;
      data.profile.picture = usersPath + 'me/avatar';
    } else {
      data.profile.picture = null;
    }

    data.is_admin = isAdmin({ id: doId, profile: data.profile, credential }, env);

    const cookieHeader = request.headers.get('Cookie') || '';
    const cookies = parseCookies(cookieHeader);
    data.is_impersonated = !!cookies['backup_session_id'];

    // Fetch credentials
    data.credentials = await userStub.listCredentials();

    // Fetch memberships to find current account
    const memberships = await userStub.getMemberships();
    const currentMembership = memberships.find((m: any) => m.is_current) || memberships[0];

    if (currentMembership) {
      const accountId = env.ACCOUNT.idFromString(currentMembership.account_id);
      const accountStub = env.ACCOUNT.get(accountId);
      const accountInfo = await accountStub.getInfo();
      data.account = {
        ...accountInfo,
        id: currentMembership.account_id,
        role: currentMembership.role,
      };
    }

    return Response.json(data);
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleUpdateProfile(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const profileData = await request.json();
  const userStub = env.USER.get(env.USER.idFromString(user.id));
  await userStub.updateProfile(profileData);

  return Response.json({ success: true });
}

function isAdmin(user: any, env: StartupAPIEnv): boolean {
  if (!env.ADMIN_IDS) return false;
  const adminIds = env.ADMIN_IDS.split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  const userId = user.id;
  const profile = user.profile || user || {};
  const credential = user.credential || user || {};
  const email = profile.email || user.email;

  return (
    adminIds.includes(userId) ||
    (env.ENVIRONMENT === 'test' &&
      adminIds.some((id) => {
        try {
          return userId === env.USER.idFromName(id).toString();
        } catch (e) {
          return false;
        }
      })) ||
    (email && adminIds.includes(email)) ||
    (credential.subject_id && adminIds.includes(credential.subject_id)) ||
    (credential.provider && credential.subject_id && adminIds.includes(`${credential.provider}:${credential.subject_id}`))
  );
}

async function handleAccountMembers(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  pathParts: string[],
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  const memberships = await userStub.getMemberships();
  const membership = memberships.find((m: any) => m.account_id === accountId);

  const isAccountAdmin = membership && (membership as any).role === AccountDO.ROLE_ADMIN;
  const isSysAdmin = isAdmin(user, env);

  if (!isAccountAdmin && !isSysAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));

  if (pathParts.length === 0) {
    if (request.method === 'GET') {
      return Response.json(await accountStub.getMembers());
    }
    if (request.method === 'POST') {
      const { user_id, role } = (await request.json()) as { user_id: string; role: number };
      return Response.json(await accountStub.addMember(user_id, role));
    }
  } else if (pathParts.length === 1) {
    const targetUserId = pathParts[0];
    if (request.method === 'DELETE') {
      if (targetUserId === user.id) {
        return new Response('Cannot remove yourself', { status: 400 });
      }
      return Response.json(await accountStub.removeMember(targetUserId));
    }
    if (request.method === 'PATCH') {
      const { role } = (await request.json()) as { role: number };
      if (targetUserId === user.id && role !== AccountDO.ROLE_ADMIN) {
        return new Response('Cannot demote yourself', { status: 400 });
      }
      return Response.json(await accountStub.updateMemberRole(targetUserId, role));
    }
  }

  return new Response('Not Found', { status: 404 });
}

async function handleAccountDetails(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  const memberships = await userStub.getMemberships();
  const membership = memberships.find((m: any) => m.account_id === accountId);

  const isAccountAdmin = membership && (membership as any).role === AccountDO.ROLE_ADMIN;
  const isSysAdmin = isAdmin(user, env);

  if (!isAccountAdmin && !isSysAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));

  if (request.method === 'GET') {
    const info = await accountStub.getInfo();
    const billing = await accountStub.getBillingInfo();
    return Response.json({ ...info, billing, role: membership?.role });
  }

  if (request.method === 'POST') {
    const data = await request.json();
    const result = await accountStub.updateInfo(data);

    // Sync with SystemDO index if name changed
    if (data.name) {
      try {
        const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
        await systemStub.updateAccount(accountId, { name: data.name });
      } catch (e) {
        console.error('Failed to sync account name to SystemDO', e);
      }
    }
    return Response.json(result);
  }

  return new Response('Method Not Allowed', { status: 405 });
}

async function getUserFromSession(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<any> {
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
    const data = await userStub.validateSession(sessionId);
    if (data.valid) return { id: doId, sessionId, profile: data.profile, credential: data.credential };
  } catch (e) {}
  return null;
}

async function handleListCredentials(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  return Response.json(await userStub.listCredentials());
}

async function handleDeleteCredential(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { provider } = (await request.json()) as { provider: string };
  const userStub = env.USER.get(env.USER.idFromString(user.id));

  try {
    return Response.json(await userStub.deleteCredential(provider));
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }
}

async function handleMeImage(request: Request, env: StartupAPIEnv, type: string, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  try {
    const id = env.USER.idFromString(user.id);
    const stub = env.USER.get(id);

    if (request.method === 'PUT') {
      const contentType = request.headers.get('Content-Type');
      if (!contentType || !contentType.startsWith('image/')) {
        return new Response('Invalid image type', { status: 400 });
      }

      const blob = await request.arrayBuffer();
      if (blob.byteLength > 1024 * 1024) {
        return new Response('Image too large (max 1MB)', { status: 400 });
      }

      await stub.storeImage(type, blob, contentType);
      return Response.json({ success: true });
    }

    if (request.method === 'DELETE') {
      await stub.deleteImage(type);
      return Response.json({ success: true });
    }

    return handleUserImage(request, env, user.id, type, cookieManager);
  } catch (e: any) {
    console.error('[handleMeImage] Error:', e.message, e.stack);
    return new Response('Error fetching image: ' + e.message, { status: 500 });
  }
}

async function handleUserImage(
  request: Request,
  env: StartupAPIEnv,
  userId: string,
  type: string,
  cookieManager: CookieManager,
): Promise<Response> {
  // Public access to user avatars (if we want them to be public in member lists)
  // Or we could check if current user has permission to see it.
  // For now, let's make it public if you know the ID.

  try {
    const id = env.USER.idFromString(userId);
    const stub = env.USER.get(id);

    const image = await stub.getImage(type);
    if (!image) return new Response('Not Found', { status: 404 });
    return new Response(image.value, { headers: { 'Content-Type': image.mime_type } });
  } catch (e) {
    return new Response('Error fetching image', { status: 500 });
  }
}

async function handleAccountImage(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  type: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  const memberships = await userStub.getMemberships();
  const membership = memberships.find((m: any) => m.account_id === accountId);

  // For viewing, we might allow any member to see account avatar
  if (!membership && !isAdmin(user, env)) {
    return new Response('Forbidden', { status: 403 });
  }

  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));

  try {
    if (request.method === 'PUT') {
      // Only admins can upload
      if (membership?.role !== AccountDO.ROLE_ADMIN && !isAdmin(user, env)) {
        return new Response('Forbidden', { status: 403 });
      }

      const contentType = request.headers.get('Content-Type');
      if (!contentType || !contentType.startsWith('image/')) {
        return new Response('Invalid image type', { status: 400 });
      }

      const blob = await request.arrayBuffer();
      if (blob.byteLength > 1024 * 1024) {
        return new Response('Image too large (max 1MB)', { status: 400 });
      }

      await accountStub.storeImage(type, blob, contentType);
      return Response.json({ success: true });
    }

    if (request.method === 'DELETE') {
      // Only admins can delete
      if (membership?.role !== AccountDO.ROLE_ADMIN && !isAdmin(user, env)) {
        return new Response('Forbidden', { status: 403 });
      }

      await accountStub.deleteImage(type);
      return Response.json({ success: true });
    }

    const image = await accountStub.getImage(type);
    if (!image) return new Response('Not Found', { status: 404 });
    return new Response(image.value, { headers: { 'Content-Type': image.mime_type } });
  } catch (e: any) {
    console.error('[handleAccountImage] Error:', e.message, e.stack);
    return new Response('Error handling account image: ' + e.message, { status: 500 });
  }
}

async function handleLogout(request: Request, env: StartupAPIEnv, usersPath: string, cookieManager: CookieManager): Promise<Response> {
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

async function handleMyAccounts(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  try {
    const id = env.USER.idFromString(user.id);
    const userStub = env.USER.get(id);

    // Fetch memberships
    const memberships = await userStub.getMemberships();

    const accounts = await Promise.all(
      memberships.map(async (m: any) => {
        try {
          const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(m.account_id));
          const info = await accountStub.getInfo();
          return {
            account_id: m.account_id,
            name: info.name || 'Unknown Account',
            role: m.role,
            is_current: m.is_current,
          };
        } catch (e) {
          return { account_id: m.account_id, name: 'Unknown Account', role: m.role, is_current: m.is_current };
        }
      }),
    );

    return Response.json(accounts);
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleSwitchAccount(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { account_id } = (await request.json()) as { account_id: string };

  if (!account_id) {
    return new Response('Missing account_id', { status: 400 });
  }

  try {
    const id = env.USER.idFromString(user.id);
    const userStub = env.USER.get(id);
    return Response.json(await userStub.switchAccount(account_id));
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }
}

async function handleSSR(
  request: Request,
  env: StartupAPIEnv,
  url: URL,
  usersPath: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return Response.redirect(url.origin + '/', 302);
  }

  const { id: doId, sessionId, profile: initialProfile, credential } = user;

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);

    // Get HTML from assets
    const assetUrl = new URL(url.toString());
    assetUrl.pathname = url.pathname.replace(usersPath, '/users/');
    const assetRequest = new Request(assetUrl.toString(), request);
    assetRequest.headers.set('x-skip-worker', 'true');
    let assetResponse = await env.ASSETS.fetch(assetRequest);

    // Follow one level of redirect if needed (e.g. for canonical URLs)
    if (assetResponse.status === 301 || assetResponse.status === 302) {
      const location = assetResponse.headers.get('Location');
      if (location) {
        const followUrl = new URL(location, assetUrl.toString());
        const followRequest = new Request(followUrl.toString(), request);
        followRequest.headers.set('x-skip-worker', 'true');
        assetResponse = await env.ASSETS.fetch(followRequest);
      }
    }

    if (!assetResponse.ok) {
      return assetResponse;
    }

    let html = await assetResponse.text();

    const data: any = {
      valid: true,
      profile: { ...initialProfile },
      credential,
    };

    const image = await userStub.getImage('avatar');
    if (image) {
      const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
      data.profile.picture = usersPathNormalized + 'me/avatar';
    } else {
      data.profile.picture = null;
    }

    data.is_admin = isAdmin({ id: doId, profile: data.profile, credential }, env);

    // Fetch memberships to find current account
    const memberships = await userStub.getMemberships();
    const currentMembership = memberships.find((m: any) => m.is_current) || memberships[0];

    // Fetch credentials
    const credentials = await userStub.listCredentials();

    let account = null;
    let accountMembers = null;
    if (currentMembership) {
      const accountId = env.ACCOUNT.idFromString(currentMembership.account_id);
      const accountStub = env.ACCOUNT.get(accountId);
      const accountInfo = await accountStub.getInfo();
      const billing = await accountStub.getBillingInfo();
      account = {
        ...accountInfo,
        billing,
        id: currentMembership.account_id,
        role: currentMembership.role,
      };
      // Fetch members only if it's the accounts page or if needed
      if (url.pathname.endsWith('/accounts.html') || url.pathname.endsWith('/accounts')) {
        accountMembers = await accountStub.getMembers();
      }
    }

    // Prepare SSR values
    const replacements: Record<string, string> = {
      providers: getActiveProviders(env).join(','),
      profile_json: JSON.stringify(data).replace(/"/g, '&quot;'),
      credentials_json: JSON.stringify(credentials).replace(/"/g, '&quot;'),
      profile_name: data.profile.name || 'Anonymous',
      profile_id: doId,
      profile_email: data.profile.email || '',
      profile_picture: data.profile.picture || '',
      profile_picture_display: data.profile.picture ? 'display: block;' : 'display: none;',
      profile_placeholder_display: data.profile.picture ? 'display: none;' : 'display: flex;',
      profile_remove_btn_display: data.profile.picture ? 'display: flex;' : 'display: none;',
      profile_provider_label: data.profile.provider
        ? `(from ${data.profile.provider.charAt(0).toUpperCase() + data.profile.provider.slice(1)})`
        : '',
      nav_account_display: account && (account.role === 1 || data.is_admin) ? 'display: block;' : 'display: none;',
      credentials_list_html: renderCredentialsList(credentials, data.credential?.provider),
      link_credentials_html: renderLinkCredentialsList(getActiveProviders(env)),
    };

    if (account) {
      replacements['account_json'] = JSON.stringify(account).replace(/"/g, '&quot;');
      replacements['account_name'] = account.name || 'Account';
      replacements['account_id'] = account.id;
      replacements['account_plan_name'] = account.billing?.plan_details?.name || account.billing?.state?.plan_slug || 'free';

      const accountAvatar = await env.ACCOUNT.get(env.ACCOUNT.idFromString(account.id)).getImage('avatar');
      const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
      const accountPicture = accountAvatar ? `${usersPathNormalized}api/me/accounts/${account.id}/avatar` : null;

      replacements['account_picture'] = accountPicture || '';
      replacements['account_picture_display'] = accountPicture ? 'display: block;' : 'display: none;';
      replacements['account_placeholder_display'] = accountPicture ? 'display: none;' : 'display: flex;';
      replacements['account_remove_btn_display'] = accountPicture ? 'display: flex;' : 'display: none;';

      const isAccountAdmin = account.role === 1 || data.is_admin;
      replacements['account_info_section_display'] = isAccountAdmin ? 'display: block;' : 'display: none;';
      replacements['account_members_section_display'] = isAccountAdmin ? 'display: block;' : 'display: none;';

      if (accountMembers) {
        replacements['account_members_json'] = JSON.stringify(accountMembers).replace(/"/g, '&quot;');
        replacements['account_members_list_html'] = renderAccountMembersList(accountMembers, doId);
      } else {
        replacements['account_members_json'] = '[]';
        replacements['account_members_list_html'] = '<p>Loading members...</p>';
      }
    } else {
      replacements['account_json'] = 'null';
      replacements['account_name'] = '';
      replacements['account_id'] = '';
      replacements['account_plan_name'] = '';
      replacements['account_picture'] = '';
      replacements['account_picture_display'] = 'display: none;';
      replacements['account_placeholder_display'] = 'display: flex;';
      replacements['account_remove_btn_display'] = 'display: none;';
      replacements['account_info_section_display'] = 'display: none;';
      replacements['account_members_section_display'] = 'display: none;';
      replacements['account_members_json'] = '[]';
      replacements['account_members_list_html'] = '';
    }

    html = renderSSR(html, replacements);

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html',
      },
    });
  } catch (e: any) {
    console.error('[handleSSR] Error:', e.message, e.stack);
    return new Response('Error rendering page: ' + e.message, { status: 500 });
  }
}

function renderSSR(html: string, replacements: Record<string, string>): string {
  return html.replace(/\{\{ssr:([a-z0-9_]+)\}\}/g, (match, key) => {
    return replacements[key] !== undefined ? replacements[key] : match;
  });
}

function renderCredentialsList(credentials: any[], currentProvider?: string): string {
  if (!credentials || credentials.length === 0) {
    return '<p>No credentials linked.</p>';
  }

  return credentials
    .map((c) => {
      const isCurrent = c.provider === currentProvider;
      return `
      <div class="credential-item ${isCurrent ? 'active' : ''}">
        <div class="credential-info">
          <div class="provider-icon">
            ${getProviderIcon(c.provider)}
          </div>
          <div>
            <div style="font-weight: 600;">
              ${c.provider.charAt(0).toUpperCase() + c.provider.slice(1)}
              ${isCurrent ? '<span class="current-badge">logged in</span>' : ''}
            </div>
            <div style="font-size: 0.8rem; color: #666;">${c.profile_data?.email || c.subject_id}</div>
          </div>
        </div>
        <button class="remove-btn" onclick="removeCredential('${c.provider}')" ${isCurrent || credentials.length === 1 ? 'disabled title="' + (isCurrent ? 'Cannot remove the method you are currently logged in with' : 'Cannot remove your last login method') + '"' : ''}>
          Remove
        </button>
      </div>
    `;
    })
    .join('');
}

function getProviderIcon(provider: string): string {
  if (provider === 'google') {
    return '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>';
  } else if (provider === 'twitch') {
    return '<svg viewBox="0 0 24 24" width="24" height="24" class="twitch-icon"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" fill="currentColor"/></svg>';
  }
  return '';
}

function renderLinkCredentialsList(providers: string[]): string {
  if (providers.length === 0) {
    return '';
  }

  return providers
    .map((provider) => {
      return `
      <a href="/users/auth/${provider}" class="link-account-btn ${provider}">
        ${getProviderIcon(provider).replace('width="24" height="24"', 'width="20" height="20"')}
        ${provider.charAt(0).toUpperCase() + provider.slice(1)}
      </a>
    `;
    })
    .join('');
}

function renderAccountMembersList(members: any[], currentUserId: string): string {
  if (!members || members.length === 0) {
    return '<p>No members found.</p>';
  }

  return members
    .map((m) => {
      const isSelf = m.user_id === currentUserId;
      const avatarContent = m.picture
        ? `<img src="${m.picture}" class="member-avatar" alt="${m.name}" />`
        : `<div class="member-avatar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                <circle cx="12" cy="7" r="4"></circle>
            </svg>
           </div>`;

      return `
      <div class="member-item">
        <div class="member-info">
          ${avatarContent}
          <div class="member-details">
            <div class="member-name" title="${m.name}${isSelf ? ' (You)' : ''}">${m.name} ${isSelf ? '(You)' : ''}</div>
            <div class="member-role">
              <select onchange="updateRole('${m.user_id}', this.value)" ${isSelf ? 'disabled title="You cannot change your own role"' : ''} class="role-select">
                <option value="0" ${m.role === 0 ? 'selected' : ''}>Member</option>
                <option value="1" ${m.role === 1 ? 'selected' : ''}>Admin</option>
              </select>
            </div>
          </div>
        </div>
        <button class="remove-btn" onclick="removeMember('${m.user_id}')" ${isSelf ? 'disabled title="You cannot remove yourself"' : ''}>
          Remove
        </button>
      </div>
    `;
    })
    .join('');
}
