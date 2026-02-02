import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('UserDO Durable Object', () => {
  it('should store and retrieve profile', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Update profile
    const profileData = { name: 'Test User', email: 'test@example.com' };
    let res = await stub.fetch('http://do/profile', {
      method: 'POST',
      body: JSON.stringify(profileData),
    });
    expect(res.status).toBe(200);
    await res.json(); // Drain body

    // Get profile
    res = await stub.fetch('http://do/profile');
    const data = await res.json();
    expect(data).toEqual(profileData);
  });

  it('should create session', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const res = await stub.fetch('http://do/sessions', {
      method: 'POST',
    });
    const data: any = await res.json();
    expect(data).toHaveProperty('sessionId');
    expect(data).toHaveProperty('expiresAt');
  });

  it('should delete session', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const res = await stub.fetch('http://do/sessions', {
      method: 'POST',
    });
    const { sessionId } = (await res.json()) as any;

    // Validate session exists
    let validRes = await stub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    let validData: any = await validRes.json();
    expect(validData.valid).toBe(true);

    // Delete session
    const delRes = await stub.fetch('http://do/sessions', {
      method: 'DELETE',
      body: JSON.stringify({ sessionId }),
    });
    const delData: any = await delRes.json();
    expect(delData.success).toBe(true);

    // Validate session is gone
    validRes = await stub.fetch('http://do/validate-session', {
      method: 'POST',
      body: JSON.stringify({ sessionId }),
    });
    validData = await validRes.json();
    expect(validData.valid).toBe(false);
  });

  it('should manage memberships', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const accountId = 'account-456';
    const role = 1;

    // Add membership
    let res = await stub.fetch('http://do/memberships', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, role, is_current: true }),
    });
    expect(res.status).toBe(200);

    // Get memberships
    res = await stub.fetch('http://do/memberships');
    const memberships: any[] = await res.json();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].account_id).toBe(accountId);
    expect(memberships[0].role).toBe(role);
    expect(memberships[0].is_current).toBe(1);
  });
});
