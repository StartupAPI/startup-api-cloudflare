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

    // Create an account and make admin a member
    const accountId = env.ACCOUNT.newUniqueId();
    const accountIdStr = accountId.toString();
    const accountStub = env.ACCOUNT.get(accountId);
    await accountStub.updateInfo({ name: 'Admin Account' });
    await accountStub.addMember(userIdStr, 1);
    await userStub.addMembership(accountIdStr, 1, true);

    adminCookie = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;
  });

  afterEach(() => {
    // Restore default plans
    initPlans();
  });

  it('should show plan selection when multiple plans are configured', async () => {
    // Manually initialize multiple plans for this test
    Plan.init([
      {
        slug: 'free',
        name: 'Free',
        schedules: [{ charge_amount: 0, charge_period: 30, is_default: true }],
      },
      {
        slug: 'pro',
        name: 'Pro',
        schedules: [{ charge_amount: 2900, charge_period: 30, is_default: true }],
      },
    ]);
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

  it('should show plan selection on accounts page when multiple plans are configured', async () => {
    // Manually initialize multiple plans for this test
    Plan.init([
      {
        slug: 'free',
        name: 'Free',
        schedules: [{ charge_amount: 0, charge_period: 30, is_default: true }],
      },
      {
        slug: 'pro',
        name: 'Pro',
        schedules: [{ charge_amount: 2900, charge_period: 30, is_default: true }],
      },
    ]);
    expect(Plan.getAll().length).toBeGreaterThan(1);

    const res = await SELF.fetch('http://example.com/users/accounts.html', {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Check SSR replacement (should NOT be empty)
    expect(html).toContain('id="display-account-plan"');
    expect(html).not.toContain('id="display-account-plan" style="margin: 0.25rem 0 0 0; color: #666"></p>');
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

  it('should hide plan selection on accounts page when only one plan is configured', async () => {
    // Re-initialize with only one plan
    Plan.init([
      {
        slug: 'free',
        name: 'Free',
        schedules: [{ charge_amount: 0, charge_period: 30, is_default: true }],
      },
    ]);
    expect(Plan.getAll().length).toBe(1);

    const res = await SELF.fetch('http://example.com/users/accounts.html', {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Check that SSR replacement for plan name is empty
    expect(html).toContain('id="display-account-plan" style="margin: 0.25rem 0 0 0; color: #666">');
    // It should literally be an empty string where {{ssr:account_plan_name}} was
    const pTagContent = html.match(/id="display-account-plan"[^>]*>([^<]*)/);
    expect(pTagContent?.[1]).toBe('');
  });
});
