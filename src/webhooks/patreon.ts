import type { StartupAPIEnv } from '../StartupAPIEnv';
import { hmacMd5Hex, timingSafeEqual } from './md5hmac';
import { computeRedirectBase, getProvider } from '../auth/providers';
import type { ProviderConfigs } from '../auth/providers';
import { refreshEntitlements } from '../entitlements/service';

/**
 * Handle a Patreon webhook (members:pledge:create|update|delete and similar). Verifies the
 * `X-Patreon-Signature` HMAC-MD5 over the raw body, then re-fetches the affected patron's entitlements
 * so gating reflects the change. Responds 200 quickly and does the refresh in the background.
 *
 * Mounted only when the Patreon provider has `webhook` enabled in the factory config; if the webhook
 * secret is not configured, returns 404 (route effectively disabled).
 */
export async function handlePatreonWebhook(
  request: Request,
  env: StartupAPIEnv,
  ctx?: ExecutionContext,
  providerConfigs: ProviderConfigs = {},
): Promise<Response> {
  const secret = env.PATREON_WEBHOOK_SECRET;
  if (!secret) return new Response('Webhook not configured', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const signature = request.headers.get('X-Patreon-Signature') || '';
  const body = await request.text();
  const expected = hmacMd5Hex(secret, body);
  if (!signature || !timingSafeEqual(signature.toLowerCase(), expected)) {
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response('Bad payload', { status: 400 });
  }

  // The webhook 'data' is a JSON:API member; the patron's Patreon user id is our credential subject_id.
  const subjectId = payload?.data?.relationships?.user?.data?.id;
  if (!subjectId) return new Response('OK', { status: 200 }); // ack — nothing to do

  const work = (async () => {
    try {
      const credStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('patreon'));
      const cred = await credStub.get(String(subjectId));
      if (!cred) return;
      const redirectBase = computeRedirectBase(env, env.AUTH_ORIGIN || 'https://localhost', '/users/');
      const provider = getProvider(env, redirectBase, 'patreon', providerConfigs);
      if (!provider) return;
      await refreshEntitlements(env, provider, { ...cred, user_id: cred.user_id }, 'webhook');
    } catch (e) {
      console.error('[webhook] patreon entitlement refresh failed', e);
    }
  })();

  if (ctx) ctx.waitUntil(work);
  else await work;

  return new Response('OK', { status: 200 });
}
