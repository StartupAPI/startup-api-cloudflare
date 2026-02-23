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
    expect(data).toEqual({
      ...profileData,
      picture: null,
      provider: null,
      verified_email: false,
    });
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

  it('should list credentials without exposing sensitive data', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Mock CredentialDO behavior
    const googleCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));
    await googleCredStub.put({
      user_id: id.toString(),
      subject_id: 'g123',
      access_token: 'secret-token',
      refresh_token: 'secret-refresh',
      profile_data: { email: 'user@example.com', extra: 'sensitive' },
    });

    await stub.addCredential('google', 'g123');

    const credentials = await stub.listCredentials();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual({
      provider: 'google',
      subject_id: 'g123',
      email: 'user@example.com',
      created_at: expect.any(Number),
    });

    // Ensure sensitive fields are NOT present
    expect(credentials[0]).not.toHaveProperty('access_token');
    expect(credentials[0]).not.toHaveProperty('refresh_token');
    expect(credentials[0]).not.toHaveProperty('profile_data');
  });
});
