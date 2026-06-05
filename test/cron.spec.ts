import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { runEntitlementResync } from '../src/entitlements/cron';

const identity = {
  data: { type: 'user', id: 'u', relationships: { memberships: { data: [{ type: 'member', id: 'm1' }] } } },
  included: [
    {
      type: 'member',
      id: 'm1',
      attributes: { patron_status: 'active_patron', currently_entitled_amount_cents: 500 },
      relationships: { currently_entitled_tiers: { data: [{ type: 'tier', id: 't1' }] }, campaign: { data: { type: 'campaign', id: 'camp-1' } } },
    },
    { type: 'tier', id: 't1', attributes: { title: 'VIP' }, relationships: { benefits: { data: [{ type: 'benefit', id: 'benefit-vip' }] } } },
    { type: 'benefit', id: 'benefit-vip', attributes: { title: 'VIP perk' } },
  ],
};

describe('runEntitlementResync', () => {
  it('re-fetches and persists entitlements for each Patreon credential', async () => {
    const u1 = env.USER.newUniqueId().toString();
    const stub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('patreon'));
    await stub.put({ subject_id: 'cron-s1', user_id: u1, access_token: 'a1', refresh_token: 'r1', expires_at: Date.now() + 3600_000 });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/identity')) {
        return new Response(JSON.stringify(identity), { status: 200, headers: { 'Content-Type': 'application/json' } }) as any;
      }
      return new Response('nf', { status: 404 }) as any;
    });

    try {
      await runEntitlementResync(env, ['patreon']);

      // Source of truth updated.
      const cred = await stub.get('cron-s1');
      expect(cred.entitlements.source).toBe('cron');
      expect(cred.entitlements.patreon.entitled_benefit_ids).toContain('benefit-vip');

      // Hot-path cache updated on the user's DO.
      const userStub = env.USER.get(env.USER.idFromString(u1));
      const cache = await userStub.getEntitlements('patreon', 'cron-s1');
      expect(cache?.data.patreon.is_active_patron).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
