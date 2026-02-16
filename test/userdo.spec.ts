import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('UserDO Durable Object', () => {
  it('should store and retrieve profile', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Update profile
    const profileData = { name: 'Test User', email: 'test@example.com' };
    await stub.updateProfile(profileData);

    // Get profile
    const data = await stub.getProfile();
    expect(data).toEqual(profileData);
  });

  it('should create session', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const data: any = await stub.createSession();
    expect(data).toHaveProperty('sessionId');
    expect(data).toHaveProperty('expiresAt');
  });

  it('should delete session', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const { sessionId } = (await stub.createSession()) as any;

    // Validate session exists
    let validData: any = await stub.validateSession(sessionId);
    expect(validData.valid).toBe(true);

    // Delete session
    const delData: any = await stub.deleteSession(sessionId);
    expect(delData.success).toBe(true);

    // Validate session is gone
    validData = await stub.validateSession(sessionId);
    expect(validData.valid).toBe(false);
  });

  it('should manage memberships', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const accountId = 'account-456';
    const role = 1;

    // Add membership
    await stub.addMembership(accountId, role, true);

    // Get memberships
    const memberships = await stub.getMemberships();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].account_id).toBe(accountId);
    expect(memberships[0].role).toBe(role);
    expect(memberships[0].is_current).toBe(1);
  });
});
