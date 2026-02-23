import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { getUserFromSession, checkAndClearStaleSession, isAdmin } from './utils';
import { AccountDO } from '../AccountDO';
import { AccountInfoSchema, MemberSchema, SwitchAccountSchema } from '../schemas/account';

export async function handleMyAccounts(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

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
        } catch (_e) {
          return { account_id: m.account_id, name: 'Unknown Account', role: m.role, is_current: m.is_current };
        }
      }),
    );

    return Response.json(accounts);
  } catch (_e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

export async function handleSwitchAccount(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

  try {
    const data = await request.json();
    const { account_id } = SwitchAccountSchema.parse(data);

    const id = env.USER.idFromString(user.id);
    const userStub = env.USER.get(id);
    return Response.json(await userStub.switchAccount(account_id));
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
  }
}

export async function handleAccountDetails(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

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
    try {
      const data = await request.json();
      const validatedData = AccountInfoSchema.partial().parse(data);
      const result = await accountStub.updateInfo(validatedData);

      // Sync with SystemDO index if name or plan changed
      if (validatedData.name || validatedData.plan) {
        try {
          const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
          const updates: any = {};
          if (validatedData.name) updates.name = validatedData.name;
          if (validatedData.plan) updates.plan = validatedData.plan;
          await systemStub.updateAccount(accountId, updates);
        } catch (_e) {
          console.error('Failed to sync account updates to SystemDO', _e);
        }
      }
      return Response.json(result);
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
}

export async function handleAccountImage(
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
  } catch (e) {
    console.error('[handleAccountImage] Error:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : '');
    return new Response(`Error handling account image: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}

export async function handleAccountMembers(
  request: Request,
  env: StartupAPIEnv,
  accountId: string,
  pathParts: string[],
  cookieManager: CookieManager,
): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

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
      try {
        const data = await request.json();
        const { user_id, role } = MemberSchema.partial().parse(data);
        if (!user_id || role === undefined) {
          return new Response('Missing user_id or role', { status: 400 });
        }
        return Response.json(await accountStub.addMember(user_id, role));
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
      }
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
      try {
        const data = await request.json();
        const { role } = MemberSchema.partial().parse(data);
        if (role === undefined) {
          return new Response('Missing role', { status: 400 });
        }
        if (targetUserId === user.id && role !== AccountDO.ROLE_ADMIN) {
          return new Response('Cannot demote yourself', { status: 400 });
        }
        return Response.json(await accountStub.updateMemberRole(targetUserId, role));
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
      }
    }
  }

  return new Response('Not Found', { status: 404 });
}
