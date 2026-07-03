import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { createStartupAPI } from '../src/createStartupAPI';
import { CookieManager } from '../src/CookieManager';
import { hmacMd5Hex } from '../src/webhooks/md5hmac';

describe('createStartupAPI factory', () => {
  it('returns the Worker handler and all Durable Object classes', () => {
    const api = createStartupAPI();
    expect(typeof api.default.fetch).toBe('function');
    expect(api.UserDO.name).toBe('UserDO');
    expect(api.AccountDO.name).toBe('AccountDO');
    expect(api.SystemDO.name).toBe('SystemDO');
    expect(api.CredentialDO.name).toBe('CredentialDO');
  });

  it('does NOT attach scheduled() when no provider enables cron', () => {
    const api = createStartupAPI();
    expect(api.scheduled).toBeUndefined();
    expect(api.default.scheduled).toBeUndefined();
  });

  it('attaches scheduled() when a provider enables cron', () => {
    const api = createStartupAPI({ providers: { patreon: { freshness: { cron: { schedule: '0 */6 * * *' } } } } });
    expect(typeof api.scheduled).toBe('function');
    expect(typeof api.default.scheduled).toBe('function');
  });

  it('rejects an entitlement condition for a non-entitlement provider at init', async () => {
    const api = createStartupAPI({
      accessPolicy: {
        rules: [{ pattern: '/x', requirement: { mode: 'entitlement', provider: 'twitch', condition: { type: 'active_patron' } } }],
      },
    });
    // Policy is initialized lazily on first request; the invalid provider should throw there.
    const ctx = createExecutionContext();
    // Force a clean re-init by resetting the global policy first.
    const { AccessPolicy } = await import('../src/policy/accessPolicy');
    AccessPolicy.reset();
    await expect(api.fetch(new Request('http://example.com/'), env, ctx)).rejects.toThrow(/twitch/);
    AccessPolicy.reset();
  });

  describe('session lifetime config', () => {
    const cookieManager = new CookieManager(env.SESSION_SECRET);

    // Drive a configured instance directly and return the renewal Set-Cookie (if any) from the proxy path.
    async function proxyRenewalCookie(config: any, remainingMs: number): Promise<string | null> {
      const api = createStartupAPI(config);
      const userId = env.USER.newUniqueId();
      const userStub = env.USER.get(userId);
      // Seed a session whose remaining life is `remainingMs`.
      const { sessionId } = await userStub.createSession({ provider: 'test' }, remainingMs);
      const cookie = await cookieManager.encrypt(`${sessionId}:${userId.toString()}`);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('OK', { status: 200 }));
      try {
        const ctx = createExecutionContext();
        const res = await api.fetch(new Request('http://example.com/page', { headers: { Cookie: `session_id=${cookie}` } }), env, ctx);
        await waitOnExecutionContext(ctx);
        return res.headers.get('Set-Cookie');
      } finally {
        fetchSpy.mockRestore();
      }
    }

    it('renews with a custom session ttl reflected in Max-Age', async () => {
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      // Remaining 1h is below the 7d/2 threshold → renew with the custom 7-day Max-Age.
      const setCookie = await proxyRenewalCookie({ session: { ttl: { ms: sevenDaysMs } } }, 60 * 60 * 1000);
      expect(setCookie).toContain('session_id=');
      expect(setCookie).toContain(`Max-Age=${sevenDaysMs / 1000}`); // 604800
    });

    it('defaults to a 30-day session when unconfigured', async () => {
      // Default ttl 30d; remaining 1h is below 15d threshold → renew with the 30-day Max-Age.
      const setCookie = await proxyRenewalCookie({}, 60 * 60 * 1000);
      expect(setCookie).toContain('Max-Age=2592000'); // 30 days
    });
  });

  describe('Patreon webhook mounting', () => {
    const webhookBody = JSON.stringify({ data: { relationships: { user: { data: { id: 'sub-unknown' } } } } });

    it('verifies a valid signature and returns 200 when webhook is enabled', async () => {
      const api = createStartupAPI({ providers: { patreon: { freshness: { webhook: true } } } });
      const sig = hmacMd5Hex(env.PATREON_WEBHOOK_SECRET!, webhookBody);
      const ctx = createExecutionContext();
      const res = await api.fetch(
        new Request('http://example.com/users/webhooks/patreon', { method: 'POST', body: webhookBody, headers: { 'X-Patreon-Signature': sig } }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(200);
    });

    it('rejects an invalid signature with 401', async () => {
      const api = createStartupAPI({ providers: { patreon: { freshness: { webhook: true } } } });
      const ctx = createExecutionContext();
      const res = await api.fetch(
        new Request('http://example.com/users/webhooks/patreon', { method: 'POST', body: webhookBody, headers: { 'X-Patreon-Signature': 'deadbeef' } }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      expect(res.status).toBe(401);
    });

    it('does NOT mount the webhook route when webhook is disabled', async () => {
      const api = createStartupAPI(); // webhook disabled
      const sig = hmacMd5Hex(env.PATREON_WEBHOOK_SECRET!, webhookBody);
      const ctx = createExecutionContext();
      const res = await api.fetch(
        new Request('http://example.com/users/webhooks/patreon', { method: 'POST', body: webhookBody, headers: { 'X-Patreon-Signature': sig } }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      // Falls through to the asset handler instead of the webhook → not the webhook's 200 OK.
      expect(res.status).not.toBe(200);
    });
  });
});
