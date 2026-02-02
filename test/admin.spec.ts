import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Admin Administration', () => {
  it('should deny access to non-admin users', async () => {
    // 1. Create a normal user
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const sessionRes = await userStub.fetch('http://do/sessions', { method: 'POST' });
    const { sessionId } = (await sessionRes.json()) as any;
    
    // Add profile data (not admin email)
    await userStub.fetch('http://do/credentials', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'test',
        subject_id: '123',
        profile_data: { email: 'normal@example.com' },
      }),
    });

    const cookieHeader = `session_id=${sessionId}:${userIdStr}`;

    // 2. Try to access admin route
    const res = await SELF.fetch('http://example.com/users/admin/users', {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(403);
  });

  it('should allow access to admin users', async () => {
    // 1. Create an admin user
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const sessionRes = await userStub.fetch('http://do/sessions', { method: 'POST' });
    const { sessionId } = (await sessionRes.json()) as any;
    
    // Add profile data (matching configured admin email)
    await userStub.fetch('http://do/credentials', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'test',
        subject_id: 'admin123',
        profile_data: { email: 'admin@example.com' },
      }),
    });

    const cookieHeader = `session_id=${sessionId}:${userIdStr}`;

    // 2. Access admin route
    const res = await SELF.fetch('http://example.com/users/admin/users', {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(200);
    const users = (await res.json()) as any[];
    expect(Array.isArray(users)).toBe(true);
  });

  it('SystemDO should list users and accounts', async () => {
    const systemId = env.SYSTEM.idFromName('global');
    const systemStub = env.SYSTEM.get(systemId);

    // Register a user
    await systemStub.fetch('http://do/users', {
      method: 'POST',
      body: JSON.stringify({
        id: 'user1',
        name: 'Alice',
        email: 'alice@example.com',
      }),
    });

    // Register an account
    await systemStub.fetch('http://do/accounts', {
      method: 'POST',
      body: JSON.stringify({
        id: 'acc1',
        name: 'Alice Inc',
      }),
    });

    // List users
    const usersRes = await systemStub.fetch('http://do/users');
    const users = (await usersRes.json()) as any[];
    expect(users.length).toBeGreaterThanOrEqual(1);
    expect(users.find((u) => u.id === 'user1')).toBeDefined();

    // List accounts
    const accountsRes = await systemStub.fetch('http://do/accounts');
    const accounts = (await accountsRes.json()) as any[];
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(accounts.find((a) => a.id === 'acc1')).toBeDefined();
  });
});
