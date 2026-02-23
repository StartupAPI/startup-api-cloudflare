import { StartupAPIEnv } from '../StartupAPIEnv';
import { CookieManager } from '../CookieManager';
import { getUserFromSession, checkAndClearStaleSession, parseCookies, isAdmin } from './utils';
import { Plan } from '../billing/Plan';
import { UserProfileSchema } from '../schemas/user';
import { DeleteCredentialSchema } from '../schemas/credential';

const DEFAULT_USERS_PATH = '/users/';

export async function handleMe(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

  const { id: doId, profile: initialProfile, credential } = user;

  try {
    const id = env.USER.idFromString(doId);
    const userStub = env.USER.get(id);

    const data: any = {
      valid: true,
      profile: { ...initialProfile },
      credential,
      plans: Plan.getAll(),
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
      const billing = await accountStub.getBillingInfo();
      data.account = {
        ...accountInfo,
        billing,
        id: currentMembership.account_id,
        role: currentMembership.role,
      };
    }

    return Response.json(data);
  } catch (_e) {
    return new Response('Unauthorized', { status: 401 });
  }
}

export async function handleUpdateProfile(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

  try {
    const profileData = await request.json();
    const validatedData = UserProfileSchema.partial().parse(profileData);
    const userStub = env.USER.get(env.USER.idFromString(user.id));
    await userStub.updateProfile(validatedData);

    return Response.json({ success: true });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
  }
}

export async function handleListCredentials(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

  const userStub = env.USER.get(env.USER.idFromString(user.id));
  return Response.json(await userStub.listCredentials());
}

export async function handleDeleteCredential(request: Request, env: StartupAPIEnv, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

  try {
    const data = await request.json();
    const { provider } = DeleteCredentialSchema.parse(data);
    const userStub = env.USER.get(env.USER.idFromString(user.id));

    return Response.json(await userStub.deleteCredential(provider));
  } catch (e) {
    return new Response(e instanceof Error ? e.message : String(e), { status: 400 });
  }
}

export async function handleMeImage(request: Request, env: StartupAPIEnv, type: string, cookieManager: CookieManager): Promise<Response> {
  const user = await getUserFromSession(request, env, cookieManager);
  if (!user) {
    return checkAndClearStaleSession(request, env, cookieManager, new Response('Unauthorized', { status: 401 }));
  }

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
  } catch (e) {
    console.error('[handleMeImage] Error:', e instanceof Error ? e.message : String(e), e instanceof Error ? e.stack : '');
    return new Response(`Error fetching image: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
}

export async function handleUserImage(
  request: Request,
  env: StartupAPIEnv,
  userId: string,
  type: string,
  _cookieManager: CookieManager,
): Promise<Response> {
  try {
    const id = env.USER.idFromString(userId);
    const stub = env.USER.get(id);

    const image = await stub.getImage(type);
    if (!image) return new Response('Not Found', { status: 404 });
    return new Response(image.value, { headers: { 'Content-Type': image.mime_type } });
  } catch (_e) {
    return new Response('Error fetching image', { status: 500 });
  }
}
