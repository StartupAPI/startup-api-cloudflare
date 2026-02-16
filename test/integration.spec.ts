import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Integration Tests', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  it('should return 401 for /api/me without cookie', async () => {
    const res = await SELF.fetch('http://example.com/users/api/me');
    expect(res.status).toBe(401);
  });

  it('should return user profile for valid session', async () => {
    // 1. Manually set up a UserDO with a session
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const { sessionId } = await stub.createSession();

    // Add some credentials/profile data via SystemDO
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerCredential({
      user_id: id.toString(),
      provider: 'test-provider',
      subject_id: '123',
      profile_data: { name: 'Integration Tester' },
    });

    // Add mapping to UserDO
    await stub.addCredential('test-provider', '123');

    // 2. Fetch /api/me with the cookie
    const doId = id.toString();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const res = await SELF.fetch('http://example.com/users/api/me', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.valid).toBe(true);
    expect(data.profile.name).toBe('Integration Tester');
  });

  it('should update user profile via /api/me/profile', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();

    // Add initial credentials via SystemDO
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerCredential({
      user_id: id.toString(),
      provider: 'test-provider',
      subject_id: '123',
      profile_data: { name: 'Original Name' },
    });

    await stub.addCredential('test-provider', '123');

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);

    // Update profile
    const updateRes = await SELF.fetch('http://example.com/users/api/me/profile', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated Name' }),
    });

    expect(updateRes.status).toBe(200);
    const updateData = (await updateRes.json()) as any;
    expect(updateData.success).toBe(true);

    // Verify update
    const meRes = await SELF.fetch('http://example.com/users/api/me', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    const meData = (await meRes.json()) as any;
    expect(meData.profile.name).toBe('Updated Name');
  });

  it('should list and delete credentials with safeguard', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();

    // Add two credentials via SystemDO and UserDO mapping
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerCredential({
      user_id: id.toString(),
      provider: 'google',
      subject_id: 'g123',
      profile_data: { email: 'google@example.com' },
    });
    await stub.addCredential('google', 'g123');

    await systemStub.registerCredential({
      user_id: id.toString(),
      provider: 'twitch',
      subject_id: 't123',
      profile_data: { email: 'twitch@example.com' },
    });
    await stub.addCredential('twitch', 't123');

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);

    // List credentials
    const listRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      headers: { Cookie: `session_id=${encryptedCookie}` },
    });
    const credentials = (await listRes.json()) as any[];
    expect(credentials.length).toBe(2);

    // Delete one
    const deleteRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      method: 'DELETE',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'twitch' }),
    });
    expect(deleteRes.status).toBe(200);

    // Try to delete the last one
    const deleteLastRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      method: 'DELETE',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'google' }),
    });
    expect(deleteLastRes.status).toBe(400);
    expect(await deleteLastRes.text()).toBe('Cannot delete the last credential');
  });

  it('should serve avatar image from /me/avatar', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const { sessionId } = await stub.createSession();

    // Store a fake image
    const imageData = new Uint8Array([1, 2, 3, 4]);
    await stub.storeImage('avatar', imageData.buffer, 'image/png');

    // Fetch image via worker
    const doId = id.toString();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const res = await SELF.fetch('http://example.com/users/me/avatar', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buffer = await res.arrayBuffer();
    expect(new Uint8Array(buffer)).toEqual(imageData);
  });

  it('should logout and invalidate session', async () => {
    // 1. Manually set up a UserDO with a session
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();

    // 2. Call /logout with the cookie
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const logoutRes = await SELF.fetch('http://example.com/users/logout', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
      redirect: 'manual', // Don't follow the redirect to /
    });

    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('Location')).toBe('/');
    // Check Set-Cookie clears the session
    const setCookie = logoutRes.headers.get('Set-Cookie');
    expect(setCookie).toContain('session_id=;');

    // 3. Verify session is actually deleted in DO
    const validData = await stub.validateSession(sessionId);
    expect(validData.valid).toBe(false);
  });
});
