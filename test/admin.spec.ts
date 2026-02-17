import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Admin Administration', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  it('should deny access to non-admin users', async () => {
    // 1. Create a normal user
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const { sessionId } = await userStub.createSession();

    // Add profile data (not admin email)
    await userStub.addCredential('test', '123');
    await userStub.updateProfile({ email: 'normal@example.com' });
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test'));
    await credentialStub.put({
      provider: 'test',
      subject_id: '123',
      user_id: userIdStr,
      profile_data: { email: 'normal@example.com' },
    });

    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;

    // 2. Try to access admin route
    const res = await SELF.fetch('http://example.com/users/admin/api/users', {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(403);
  });

  it('should allow access to admin users', async () => {
    // 1. Get an admin user ID from environment
    const userId = env.USER.idFromName('admin');
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const { sessionId } = await userStub.createSession();

    // Add profile data
    await userStub.addCredential('test', 'admin123');
    await userStub.updateProfile({ email: 'admin@example.com' });
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test'));
    await credentialStub.put({
      provider: 'test',
      subject_id: 'admin123',
      user_id: userIdStr,
      profile_data: { email: 'admin@example.com' },
    });

    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;

    // 2. Access admin route
    const res = await SELF.fetch('http://example.com/users/admin/api/users', {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(200);
    const users = (await res.json()) as any[];
    expect(Array.isArray(users)).toBe(true);
  });

  it('should serve admin dashboard at /users/admin/', async () => {
    // 1. Get an admin user ID from environment
    const userId = env.USER.idFromName('admin');
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const { sessionId } = await userStub.createSession();

    // Add profile data
    await userStub.addCredential('test', 'admin123');
    await userStub.updateProfile({ email: 'admin@example.com' });
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test'));
    await credentialStub.put({
      provider: 'test',
      subject_id: 'admin123',
      user_id: userIdStr,
      profile_data: { email: 'admin@example.com' },
    });

    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;

    // 2. Access admin dashboard
    const res = await SELF.fetch('http://example.com/users/admin/', {
      headers: { Cookie: cookieHeader },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Admin Dashboard</title>');
  });

  it('SystemDO should list users and accounts', async () => {
    const systemId = env.SYSTEM.idFromName('global');
    const systemStub = env.SYSTEM.get(systemId);

    // Register a user
    await systemStub.registerUser({
      id: 'user1',
      name: 'Alice',
      email: 'alice@example.com',
    });

    // Register an account
    await systemStub.registerAccount({
      id: 'acc1',
      name: 'Alice Inc',
    });

    // List users
    const users = await systemStub.listUsers();
    expect(users.length).toBeGreaterThanOrEqual(1);
    expect(users.find((u: any) => u.id === 'user1')).toBeDefined();

    // List accounts
    const accounts = await systemStub.listAccounts();
    expect(accounts.length).toBeGreaterThanOrEqual(1);
    expect(accounts.find((a: any) => a.id === 'acc1')).toBeDefined();
  });

  it('should create a new account via admin API', async () => {
    // 1. Get an admin user ID from environment
    const userId = env.USER.idFromName('admin');
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Create session
    const { sessionId } = await userStub.createSession();

    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;

    // 2. Create a new account
    const accountName = 'New Admin Account';
    const res = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: accountName,
        plan: 'pro',
      }),
    });

    expect(res.status).toBe(200);
    const result = (await res.json()) as any;
    expect(result.success).toBe(true);
    expect(result.id).toBeDefined();

    // 3. Verify account exists in list
    const listRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      headers: { Cookie: cookieHeader },
    });
    const accounts = (await listRes.json()) as any[];
    const newAccount = accounts.find((a) => a.name === accountName);
    expect(newAccount).toBeDefined();
    expect(newAccount.plan).toBe('pro');

    // 4. Verify AccountDO info
    const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(result.id));
    const info = await accountStub.getInfo();
    expect(info.name).toBe(accountName);
  });

  it('should create a new account with an owner via admin API', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create a target user who will be the owner
    const ownerId = env.USER.newUniqueId();
    const ownerIdStr = ownerId.toString();
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerUser({
      id: ownerIdStr,
      name: 'Target Owner',
    });

    // 3. Create a new account with this owner
    const accountName = 'Owned Account';
    const res = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: accountName,
        ownerId: ownerIdStr,
      }),
    });

    expect(res.status).toBe(200);
    const result = (await res.json()) as any;
    const accountId = result.id;

    // 4. Verify AccountDO has the member
    const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));
    const members = await accountStub.getMembers();
    expect(members.find((m: any) => m.user_id === ownerIdStr && m.role === 1)).toBeDefined();

    // 5. Verify UserDO has the membership
    const ownerStub = env.USER.get(ownerId);
    const memberships = await ownerStub.getMemberships();
    expect(memberships.find((m: any) => m.account_id === accountId && m.role === 1)).toBeDefined();
  });

  it('should manage account members via admin API', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create an account
    const createRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Member Test Account' }),
    });
    const { id: accountId } = (await createRes.json()) as any;

    // 3. Create a user to add
    const userId = env.USER.newUniqueId();
    const userIdStr = userId.toString();

    // 4. Add member via admin API
    const addRes = await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userIdStr, role: 0 }),
    });
    expect(addRes.status).toBe(200);

    // 5. List members via admin API
    const listRes = await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members`, {
      headers: { Cookie: cookieHeader },
    });
    const members = (await listRes.json()) as any[];
    expect(members.find((m) => m.user_id === userIdStr)).toBeDefined();

    // 6. Remove member via admin API
    const removeRes = await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members/${userIdStr}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    expect(removeRes.status).toBe(200);

    // 7. Verify removed
    const listRes2 = await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members`, {
      headers: { Cookie: cookieHeader },
    });
    const members2 = (await listRes2.json()) as any[];
    expect(members2.find((m) => m.user_id === userIdStr)).toBeUndefined();
  });

  it('should track member_count in SystemDO', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create an account
    const createRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Count Test Account' }),
    });
    const { id: accountId } = (await createRes.json()) as any;

    // 3. Verify initial count is 0
    let listRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      headers: { Cookie: cookieHeader },
    });
    let accounts = (await listRes.json()) as any[];
    let account = accounts.find((a) => a.id === accountId);
    expect(account.member_count).toBe(0);

    // 4. Add a member
    const userId = env.USER.newUniqueId().toString();
    await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members`, {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: userId, role: 0 }),
    });

    // 5. Verify count is 1
    listRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      headers: { Cookie: cookieHeader },
    });
    accounts = (await listRes.json()) as any[];
    account = accounts.find((a) => a.id === accountId);
    expect(account.member_count).toBe(1);

    // 6. Remove member
    await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}/members/${userId}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });

    // 7. Verify count is 0 again
    listRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      headers: { Cookie: cookieHeader },
    });
    accounts = (await listRes.json()) as any[];
    account = accounts.find((a) => a.id === accountId);
    expect(account.member_count).toBe(0);
  });

  it('should delete an account via admin API', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create an account
    const createRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Delete Me Account' }),
    });
    const { id: accountId } = (await createRes.json()) as any;

    // 3. Delete the account
    const deleteRes = await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    expect(deleteRes.status).toBe(200);

    // 4. Verify account is gone from list
    const listRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      headers: { Cookie: cookieHeader },
    });
    const accounts = (await listRes.json()) as any[];
    expect(accounts.find((a) => a.id === accountId)).toBeUndefined();

    // 5. Verify AccountDO is cleared (should return 404 or empty info)
    const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));
    const info = await accountStub.getInfo();
    expect(Object.keys(info).length).toBe(0);
  });

  it('should delete a user via admin API', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create a user to delete
    const userId = env.USER.newUniqueId();
    const userIdStr = userId.toString();
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerUser({
      id: userIdStr,
      name: 'Delete Me User',
    });

    // 3. Delete the user
    const deleteRes = await SELF.fetch(`http://example.com/users/admin/api/users/${userIdStr}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });
    expect(deleteRes.status).toBe(200);

    // 4. Verify user is gone from list
    const listRes = await SELF.fetch('http://example.com/users/admin/api/users', {
      headers: { Cookie: cookieHeader },
    });
    const users = (await listRes.json()) as any[];
    expect(users.find((u) => u.id === userIdStr)).toBeUndefined();

    // 5. Verify UserDO is cleared
    const targetUserStub = env.USER.get(userId);
    const profile = await targetUserStub.getProfile();
    expect(Object.keys(profile).length).toBe(0);
  });

  it('should remove memberships from users when account is deleted', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId } = await adminStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Create an account with an owner
    const ownerId = env.USER.newUniqueId();
    const ownerIdStr = ownerId.toString();
    const createRes = await SELF.fetch('http://example.com/users/admin/api/accounts', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Cleanup Test Account', ownerId: ownerIdStr }),
    });
    const { id: accountId } = (await createRes.json()) as any;

    // 3. Verify membership exists in UserDO
    const ownerStub = env.USER.get(ownerId);
    let memberships = await ownerStub.getMemberships();
    expect(memberships.find((m: any) => m.account_id === accountId)).toBeDefined();

    // 4. Delete the account
    await SELF.fetch(`http://example.com/users/admin/api/accounts/${accountId}`, {
      method: 'DELETE',
      headers: { Cookie: cookieHeader },
    });

    // 5. Verify membership is gone from UserDO
    memberships = await ownerStub.getMemberships();
    expect(memberships.find((m: any) => m.account_id === accountId)).toBeUndefined();
  });

  it('should support stop-impersonation', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminStub = env.USER.get(adminId);
    const adminIdStr = adminId.toString();

    const { sessionId: adminSessionId } = await adminStub.createSession();
    const encryptedAdminSession = await cookieManager.encrypt(`${adminSessionId}:${adminIdStr}`);
    const adminCookie = `session_id=${encryptedAdminSession}`;

    // 2. Impersonate another user
    const targetUserId = env.USER.newUniqueId().toString();
    const impRes = await SELF.fetch('http://example.com/users/admin/api/impersonate', {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: targetUserId }),
    });

    const setCookie = impRes.headers.get('Set-Cookie');
    expect(setCookie).toContain('backup_session_id=');

    // Get the new session cookie
    const cookies = impRes.headers.getSetCookie();
    const impCookie = cookies.find((c) => c.startsWith('session_id='));
    const backupCookieStr = cookies.find((c) => c.startsWith('backup_session_id='));
    const backupCookieValue = backupCookieStr?.split(';')[0].split('=')[1];

    // Verify backup session contains the original session info
    const decryptedBackup = await cookieManager.decrypt(backupCookieValue!);
    expect(decryptedBackup).toBe(`${adminSessionId}:${adminIdStr}`);

    const combinedCookie = `${impCookie}; ${backupCookieStr}`;

    // 3. Stop impersonation
    const stopRes = await SELF.fetch('http://example.com/users/api/stop-impersonation', {
      method: 'POST',
      headers: { Cookie: combinedCookie },
    });

    expect(stopRes.status).toBe(200);
    const stopSetCookie = stopRes.headers.getSetCookie();
    const restoredSessionCookie = stopSetCookie.find((c) => c.startsWith('session_id='));
    const restoredSessionValue = restoredSessionCookie?.split(';')[0].split('=')[1];
    const decryptedRestored = await cookieManager.decrypt(restoredSessionValue!);
    expect(decryptedRestored).toBe(`${adminSessionId}:${adminIdStr}`);

    const deletedBackup = stopSetCookie.find((c) => c.startsWith('backup_session_id=;'));
    expect(deletedBackup).toBeDefined();
  });

  it('should not allow admin to impersonate themselves', async () => {
    // 1. Get an admin user
    const adminId = env.USER.idFromName('admin');
    const adminIdStr = adminId.toString();

    const userStub = env.USER.get(adminId);
    const { sessionId } = await userStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${adminIdStr}`)}`;

    // 2. Try to impersonate themselves
    const res = await SELF.fetch('http://example.com/users/admin/api/impersonate', {
      method: 'POST',
      headers: {
        Cookie: cookieHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: adminIdStr }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Cannot impersonate yourself');
  });
});
