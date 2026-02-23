import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { Plan } from '../src/billing/Plan';

describe('Billing Logic in AccountDO', () => {
  beforeAll(() => {
    Plan.init([
      {
        slug: 'free',
        name: 'Free',
        capabilities: { can_access_basic: true, can_access_pro: false },
        schedules: [{ charge_amount: 0, charge_period: 30, is_default: true }],
      },
      {
        slug: 'pro',
        name: 'Pro',
        capabilities: { can_access_basic: true, can_access_pro: true },
        downgrade_to_slug: 'free',
        grace_period: 7,
        schedules: [{ charge_amount: 2900, charge_period: 30, is_default: true }],
      },
      {
        slug: 'enterprise',
        name: 'Enterprise',
        capabilities: { can_access_basic: true, can_access_pro: true, can_access_enterprise: true },
        downgrade_to_slug: 'pro',
        grace_period: 14,
        schedules: [{ charge_amount: 49900, charge_period: 30, is_default: true }],
      },
    ]);
  });

  it('should start with default free plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const data: any = await stub.getBillingInfo();

    expect(data.state.plan_slug).toBe('free');
    expect(data.state.status).toBe('active');
    expect(data.plan_details.slug).toBe('free');
  });

  it('should subscribe to a new plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Subscribe to Pro
    const result: any = await stub.subscribe('pro', 0);
    expect(result.success).toBe(true);
    expect(result.state.plan_slug).toBe('pro');
    expect(result.state.status).toBe('active');
    expect(result.state.next_billing_date).toBeDefined();

    // Verify persistence
    const info: any = await stub.getBillingInfo();
    expect(info.state.plan_slug).toBe('pro');

    // Verify getInfo also has the correct plan
    const accountInfo: any = await stub.getInfo();
    expect(accountInfo.plan).toBe('pro');
  });

  it('should fail to subscribe to invalid plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    await expect(stub.subscribe('invalid-plan')).rejects.toThrow('Plan not found');
  });

  it('should cancel subscription', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Subscribe first
    await stub.subscribe('pro');

    // Cancel
    const result: any = await stub.cancelSubscription();
    expect(result.state.status).toBe('canceled');
    expect(result.state.next_plan_slug).toBe('free'); // Based on plansConfig.ts
  });

  it('should support enterprise plan', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    await stub.subscribe('enterprise');
    const info: any = await stub.getBillingInfo();
    expect(info.state.plan_slug).toBe('enterprise');
    expect(info.plan_details.name).toBe('Enterprise');
    expect(info.plan_details.capabilities.can_access_enterprise).toBe(true);
  });
});
