import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Billing Logic in AccountDO', () => {
  it('should start with default free plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const res = await stub.fetch('http://do/billing');
    expect(res.status).toBe(200);
    const data: any = await res.json();
    
    expect(data.state.plan_slug).toBe('free');
    expect(data.state.status).toBe('active');
    expect(data.plan_details.slug).toBe('free');
  });

  it('should subscribe to a new plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Subscribe to Pro
    const res = await stub.fetch('http://do/billing/subscribe', {
        method: 'POST',
        body: JSON.stringify({ plan_slug: 'pro', schedule_idx: 0 })
    });
    expect(res.status).toBe(200);
    const result: any = await res.json();
    expect(result.success).toBe(true);
    expect(result.state.plan_slug).toBe('pro');
    expect(result.state.status).toBe('active');
    expect(result.state.next_billing_date).toBeDefined();

    // Verify persistence
    const infoRes = await stub.fetch('http://do/billing');
    const info: any = await infoRes.json();
    expect(info.state.plan_slug).toBe('pro');
  });

  it('should fail to subscribe to invalid plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const res = await stub.fetch('http://do/billing/subscribe', {
        method: 'POST',
        body: JSON.stringify({ plan_slug: 'invalid-plan' })
    });
    expect(res.status).toBe(400);
  });

  it('should cancel subscription', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Subscribe first
    await stub.fetch('http://do/billing/subscribe', {
        method: 'POST',
        body: JSON.stringify({ plan_slug: 'pro' })
    });

    // Cancel
    const res = await stub.fetch('http://do/billing/cancel', {
        method: 'POST'
    });
    expect(res.status).toBe(200);
    const result: any = await res.json();
    expect(result.state.status).toBe('canceled');
    expect(result.state.next_plan_slug).toBe('free'); // Based on plansConfig.ts
  });
});
