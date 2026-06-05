import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createStartupAPI } from '../src/createStartupAPI';
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
