import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CookieManager } from '../src/CookieManager';
import { Plan } from '../src/billing/Plan';
import { initPlans } from '../src/billing/plansConfig';

describe('Plan Visibility', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);
  let adminCookie: string;

  beforeEach(async () => {
    initPlans();

    const userId = env.USER.idFromName('admin');
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();
    const { sessionId } = await userStub.createSession();

    // Add profile data
    await userStub.addCredential('test', 'admin123');
    await userStub.updateProfile({ email: 'admin@example.com' });
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test'));
    await credentialStub.put({
      subject_id: 'admin123',
      user_id: userIdStr,
      profile_data: { email: 'admin@example.com' },
    });

    adminCookie = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;
  });

  afterEach(() => {
    // Restore default plans
    initPlans();
  });

  it('should show plan selection when multiple plans are configured', async () => {
    // Default config has 3 plans: free, pro, enterprise
    expect(Plan.getAll().length).toBeGreaterThan(1);

    const res = await SELF.fetch('http://example.com/users/admin/', {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // The logic is in JS, so we check if the JS code is present and correct
    expect(html).toContain("plans.length > 1 ? 'block' : 'none'");

    // Also verify plans_json contains multiple plans
    const plansMatch = html.match(/data-ssr-plans="([^"]+)"/);
    expect(plansMatch).not.toBeNull();
    const plans = JSON.parse(plansMatch![1].replace(/&quot;/g, '"'));
    expect(plans.length).toBeGreaterThan(1);
  });

  it('should hide plan selection when only one plan is configured', async () => {
    // Re-initialize with only one plan
    Plan.init([
      {
        slug: 'free',
        name: 'Free',
        schedules: [{ charge_amount: 0, charge_period: 30, is_default: true }],
      },
    ]);
    expect(Plan.getAll().length).toBe(1);

    const res = await SELF.fetch('http://example.com/users/admin/', {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Verify plans_json contains only one plan
    const plansMatch = html.match(/data-ssr-plans="([^"]+)"/);
    expect(plansMatch).not.toBeNull();
    const plans = JSON.parse(plansMatch![1].replace(/&quot;/g, '"'));
    expect(plans.length).toBe(1);
  });
});
