import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Permission Enforcement', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  async function createSession(userIdStr: string) {
    const userStub = env.USER.get(env.USER.idFromString(userIdStr));
    const { sessionId } = await userStub.createSession();
    return `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;
  }

  async function setupAccount(name: string) {
    const accId = env.ACCOUNT.newUniqueId();
    const accIdStr = accId.toString();
    const accStub = env.ACCOUNT.get(accId);
    await accStub.updateInfo({ name });
    return { accId, accIdStr, accStub };
  }

  async function setupUser(role?: number, accIdStr?: string) {
    const userId = env.USER.newUniqueId();
    const userIdStr = userId.toString();
    const cookie = await createSession(userIdStr);

    if (accIdStr !== undefined && role !== undefined) {
      const accStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accIdStr));
      await accStub.addMember(userIdStr, role);
    }

    return { userId, userIdStr, cookie };
  }

  it('Account Admin can perform all management tasks', async () => {
    const { accIdStr } = await setupAccount('Admin Test Account');
    const { cookie: adminCookie, userIdStr: adminIdStr } = await setupUser(1, accIdStr); // ROLE_ADMIN = 1
    const { userIdStr: otherUserId } = await setupUser();

    // 1. Can list members
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { Cookie: adminCookie },
    });
    expect(listRes.status).toBe(200);

    // 2. Can add members
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: otherUserId, role: 0 }),
    });
    expect(addRes.status).toBe(200);

    // 3. Can update roles
    const patchRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${otherUserId}`, {
      method: 'PATCH',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 1 }),
    });
    expect(patchRes.status).toBe(200);

    // 4. Can update account name
    const updateRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      method: 'POST',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(updateRes.status).toBe(200);

    // 5. Can remove others
    const removeRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${otherUserId}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    expect(removeRes.status).toBe(200);

    // 6. Cannot remove themselves
    const selfRemoveRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${adminIdStr}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    expect(selfRemoveRes.status).toBe(400);

    // 7. Cannot demote themselves
    const selfDemoteRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${adminIdStr}`, {
      method: 'PATCH',
      headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 0 }),
    });
    expect(selfDemoteRes.status).toBe(400);
  });

  it('Regular Member is forbidden from management tasks', async () => {
    const { accIdStr } = await setupAccount('Member Test Account');
    const { cookie: memberCookie } = await setupUser(0, accIdStr); // ROLE_USER = 0
    const { userIdStr: otherUserId } = await setupUser();

    // 1. Cannot list members
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { Cookie: memberCookie },
    });
    expect(listRes.status).toBe(403);

    // 2. Cannot add members
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: otherUserId, role: 0 }),
    });
    expect(addRes.status).toBe(403);

    // 3. Cannot update roles
    const patchRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${otherUserId}`, {
      method: 'PATCH',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 1 }),
    });
    expect(patchRes.status).toBe(403);

    // 4. Cannot update account name
    const updateRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacker Name' }),
    });
    expect(updateRes.status).toBe(403);

    // 5. Cannot get account details (including billing)
    const detailsRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      headers: { Cookie: memberCookie },
    });
    expect(detailsRes.status).toBe(403);
  });

  it('Non-member is forbidden from management tasks', async () => {
    const { accIdStr } = await setupAccount('Non-member Test Account');
    const { cookie: nonMemberCookie } = await setupUser();
    const { userIdStr: otherUserId } = await setupUser();

    // 1. Cannot list members
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { Cookie: nonMemberCookie },
    });
    expect(listRes.status).toBe(403);

    // 2. Cannot add members
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { Cookie: nonMemberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: otherUserId, role: 0 }),
    });
    expect(addRes.status).toBe(403);

    // 3. Cannot update account name
    const updateRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      method: 'POST',
      headers: { Cookie: nonMemberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Hacker Name' }),
    });
    expect(updateRes.status).toBe(403);
  });

  it('System Admin can bypass all checks', async () => {
    const { accIdStr } = await setupAccount('System Admin Test Account');

    const adminIds = (env.ADMIN_IDS || '').split(',').map((id) => id.trim());
    const systemAdminId = env.USER.idFromName(adminIds[0]);
    const systemAdminIdStr = systemAdminId.toString();
    const systemAdminCookie = await createSession(systemAdminIdStr);

    const { userIdStr: otherUserId } = await setupUser();

    // 1. Can list members of any account
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { Cookie: systemAdminCookie },
    });
    expect(listRes.status).toBe(200);

    // 2. Can add members to any account
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { Cookie: systemAdminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: otherUserId, role: 0 }),
    });
    expect(addRes.status).toBe(200);

    // 3. Can update account name of any account
    const updateRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      method: 'POST',
      headers: { Cookie: systemAdminCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'System Updated Name' }),
    });
    expect(updateRes.status).toBe(200);
  });
});
