import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './storage/UserDO';
import { AccountDO } from './storage/AccountDO';
import { SystemDO } from './storage/SystemDO';
import { CredentialDO } from './storage/CredentialDO';
import { CookieManager } from './CookieManager';
import { initPlans } from './billing/plansConfig';
import { getActiveProviders, parseCookies, getUserFromSession } from './handlers/utils';
import { handleAdmin } from './handlers/admin';
import {
  handleMe,
  handleUpdateProfile,
  handleListCredentials,
  handleDeleteCredential,
  handleMeImage,
  handleUserImage,
} from './handlers/user';
import { handleMyAccounts, handleSwitchAccount, handleAccountDetails, handleAccountImage, handleAccountMembers } from './handlers/account';
import { handleLogout } from './handlers/auth';
import { handleSSR } from './handlers/ssr';

const DEFAULT_USERS_PATH = '/users/';

export { UserDO, AccountDO, SystemDO, CredentialDO };

import type { StartupAPIEnv } from './StartupAPIEnv';

export default {
  /**
   * Main Worker fetch handler.
   */
  async fetch(request: Request, env: StartupAPIEnv): Promise<Response> {
    initPlans();

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

      if (apiPath.startsWith('/users/')) {
        const parts = apiPath.split('/');
        if (parts.length === 4 && parts[3] === 'avatar') {
          return handleUserImage(request, env, parts[2], 'avatar', cookieManager);
        }
      }
    }

    if (url.pathname === usersPath + 'logout') {
      return handleLogout(request, env, url, usersPath, cookieManager);
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

      const user = await getUserFromSession(request, env, cookieManager);
      if (user) {
        newRequest.headers.set('X-StartupAPI-User-Id', user.id);
        const userStub = env.USER.get(env.USER.idFromString(user.id));
        const currentAccount = await userStub.getCurrentAccount();
        if (currentAccount) {
          newRequest.headers.set('X-StartupAPI-Account-Id', currentAccount.account_id);
        }
      }

      const response = await fetch(newRequest);
      const providers = getActiveProviders(env);

      return injectPowerStrip(response, usersPath, providers);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<StartupAPIEnv>;
