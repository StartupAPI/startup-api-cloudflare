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
                    const data = await request.json() as any;
                    return Response.json(await accountStub.addMember(data.user_id, data.role));
                }
            } else if (parts.length === 4 && request.method === 'DELETE') {
                return Response.json(await accountStub.removeMember(parts[3]));
            }
        }
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
      const { sessionId } = await targetUserStub.createSession();

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
    const data = await userStub.validateSession(sessionId);

    if (data.valid) {
      return {
        id: doId,
        profile: data.profile,
        credential: data.credential,
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
  const profile = user.profile || {};
  const credential = user.credential || {};

  return (
    adminIds.includes(user.id) ||
    (env.ENVIRONMENT === 'test' && adminIds.some(id => {
        try {
            return user.id === env.USER.idFromName(id).toString();
        } catch(e) {
            return false;
        }
    })) ||
    (profile.email && adminIds.includes(profile.email)) ||
    (credential.subject_id && adminIds.includes(credential.subject_id)) ||
    (credential.provider && credential.subject_id && adminIds.includes(`${credential.provider}:${credential.subject_id}`))
  );
}

async function handleAccountMembers(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  extraParts: string[],
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) return new Response('Unauthorized', { status: 401 });

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  const memberships = await userStub.getMemberships();
  const membership = memberships.find((m: any) => m.account_id === accountId);

  const isAccountAdmin = membership && membership.role === AccountDO.ROLE_ADMIN;
  const isSysAdmin = isAdmin(user, env);

  if (!isAccountAdmin && !isSysAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));

  if (extraParts.length === 0) {
    if (request.method === 'GET') {
      return Response.json(await accountStub.getMembers());
    }
    if (request.method === 'POST') {
      const { user_id, role } = (await request.json()) as { user_id: string; role: number };
      return Response.json(await accountStub.addMember(user_id, role));
    }
  } else if (extraParts.length === 1) {
    const userIdToManage = extraParts[0];
    if (request.method === 'DELETE') {
      if (userIdToManage === user.id) {
        return new Response('Cannot remove yourself', { status: 400 });
      }
      return Response.json(await accountStub.removeMember(userIdToManage));
    }
    if (request.method === 'PATCH') {
      const { role } = (await request.json()) as { role: number };
      if (userIdToManage === user.id && role !== AccountDO.ROLE_ADMIN) {
        return new Response('Cannot demote yourself', { status: 400 });
      }
      return Response.json(await accountStub.updateMemberRole(userIdToManage, role));
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

  const isAccountAdmin = membership && membership.role === AccountDO.ROLE_ADMIN;
  const isSysAdmin = isAdmin(user, env);

  if (!isAccountAdmin && !isSysAdmin) {
    return new Response('Forbidden', { status: 403 });
  }

  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));

  if (request.method === 'POST') {
    const data = await request.json() as any;
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

  const info = await accountStub.getInfo();
  const billing = await accountStub.getBillingInfo();

  return Response.json({
    ...info,
    id: accountId,
    role: membership ? membership.role : null,
    billing,
  });
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
    const data = await userStub.validateSession(sessionId);

    if (!data.valid) return Response.json(data, { status: 401 });

    const profile = { ...data.profile };
    const image = await userStub.getImage('avatar');
    if (image) {
      const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;
      profile.picture = usersPath + 'me/avatar';
    }

    data.profile = profile;
    data.is_admin = isAdmin({ id: doId, ...data.profile }, env);
    data.is_impersonated = !!cookies['backup_session_id'];

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
          role: currentMembership.role
      };
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
    const data = await userStub.validateSession(sessionId);

    if (!data.valid) return Response.json(data, { status: 401 });

    const profileData = await request.json() as any;
    return Response.json(await userStub.updateProfile(profileData));
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleListCredentials(
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

  const [, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    return Response.json(await userStub.listCredentials());
  } catch (e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

async function handleDeleteCredential(
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

  const [, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);
    const { provider } = await request.json() as any;
    return Response.json(await userStub.deleteCredential(provider));
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
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

  const [sessionId, doId] = sessionCookie.split(':');

  try {
    const id = env.USER.idFromString(doId);
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

    return handleUserImage(request, env, doId, type, cookieManager);
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

    const image = await accountStub.getImage(type);
    if (!image) return new Response('Not Found', { status: 404 });
    return new Response(image.value, { headers: { 'Content-Type': image.mime_type } });
  } catch (e: any) {
    console.error('[handleAccountImage] Error:', e.message, e.stack);
    return new Response('Error handling account image: ' + e.message, { status: 500 });
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
    const data = await userStub.validateSession(sessionId);

    if (!data.valid) return Response.json(data, { status: 401 });

    // Fetch memberships
    const memberships = await userStub.getMemberships();

    const accounts = await Promise.all(
      memberships.map(async (m: any) => {
        const accountId = env.ACCOUNT.idFromString(m.account_id);
        const accountStub = env.ACCOUNT.get(accountId);
        const info = await accountStub.getInfo();
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
    const data = await userStub.validateSession(sessionId);

    if (!data.valid) return Response.json(data, { status: 401 });

    return Response.json(await userStub.switchAccount(account_id));
  } catch (e: any) {
    return new Response(e.message, { status: 400 });
  }
}
