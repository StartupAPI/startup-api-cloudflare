import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Account Membership Management', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  async function createSession(userIdStr: string) {
      const userStub = env.USER.get(env.USER.idFromString(userIdStr));
      const { sessionId } = await userStub.createSession();
      return `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;
  }

  it('should allow account admin to add and remove members', async () => {
    // 1. Setup Admin User
    const adminId = env.USER.newUniqueId();
    const adminIdStr = adminId.toString();
    const adminCookie = await createSession(adminIdStr);

    // 2. Setup Account
    const accId = env.ACCOUNT.newUniqueId();
    const accIdStr = accId.toString();
    const accStub = env.ACCOUNT.get(accId);
    await accStub.updateInfo({ name: 'Test Account' });
    await accStub.addMember(adminIdStr, 1); // 1 = ROLE_ADMIN

    // 3. Setup Another User to be added
    const userId = env.USER.newUniqueId();
    const userIdStr = userId.toString();

    // 4. Add Member via API
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { 
          'Cookie': adminCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: userIdStr, role: 0 }),
    });
    expect(addRes.status).toBe(200);
    const addData = await addRes.json() as any;
    expect(addData.success).toBe(true);

    // 5. List Members via API
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { 'Cookie': adminCookie },
    });
    expect(listRes.status).toBe(200);
    const members = await listRes.json() as any[];
    expect(members.length).toBe(2);
    expect(members.some(m => m.user_id === userIdStr)).toBe(true);

    // 6. Remove Member via API
    const removeRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${userIdStr}`, {
      method: 'DELETE',
      headers: { 'Cookie': adminCookie },
    });
    expect(removeRes.status).toBe(200);
    const removeData = await removeRes.json() as any;
    expect(removeData.success).toBe(true);

    // 7. Verify member removed
    const listRes2 = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { 'Cookie': adminCookie },
    });
    const members2 = await listRes2.json() as any[];
    expect(members2.length).toBe(1);
    expect(members2.some(m => m.user_id === userIdStr)).toBe(false);

    // 8. Fetch Account Details
    const detailsRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      headers: { 'Cookie': adminCookie },
    });
    expect(detailsRes.status).toBe(200);
    const details = await detailsRes.json() as any;
    expect(details.id).toBe(accIdStr);
    expect(details.billing).toBeDefined();
    expect(details.billing.state.plan_slug).toBe('free');

    // 9. Update Account Name
    const updateRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      method: 'POST',
      headers: { 
          'Cookie': adminCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Updated Account Name' }),
    });
    expect(updateRes.status).toBe(200);
    
    // Verify name updated in details
    const detailsRes2 = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}`, {
      headers: { 'Cookie': adminCookie },
    });
    const details2 = await detailsRes2.json() as any;
    expect(details2.name).toBe('Updated Account Name');

    // 10. Update Member Role
    const userIdToUpdate = env.USER.newUniqueId().toString();
    await (env.ACCOUNT.get(env.ACCOUNT.idFromString(accIdStr))).addMember(userIdToUpdate, 0);
    
    const patchRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${userIdToUpdate}`, {
      method: 'PATCH',
      headers: { 
          'Cookie': adminCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 1 }),
    });
    expect(patchRes.status).toBe(200);

    // 11. Protect self from removal
    const selfRemoveRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${adminIdStr}`, {
      method: 'DELETE',
      headers: { 'Cookie': adminCookie },
    });
    expect(selfRemoveRes.status).toBe(400);

    // 12. Protect self from demotion
    const selfDemoteRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members/${adminIdStr}`, {
      method: 'PATCH',
      headers: { 
          'Cookie': adminCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ role: 0 }),
    });
    expect(selfDemoteRes.status).toBe(400);
  });

  it('should not allow non-admin to add members', async () => {
    // 1. Setup Non-Admin User
    const userId = env.USER.newUniqueId();
    const userIdStr = userId.toString();
    const userCookie = await createSession(userIdStr);

    // 2. Setup Account
    const accId = env.ACCOUNT.newUniqueId();
    const accIdStr = accId.toString();
    const accStub = env.ACCOUNT.get(accId);
    await accStub.updateInfo({ name: 'Test Account' });
    await accStub.addMember(userIdStr, 0); // 0 = ROLE_USER

    // 3. Another user to try to add
    const otherUserId = env.USER.newUniqueId().toString();

    // 4. Try to add member via API
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { 
          'Cookie': userCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: otherUserId, role: 0 }),
    });
    expect(addRes.status).toBe(403);
  });

  it('should allow system admin to manage members of any account', async () => {
    // 1. Setup System Admin
    const adminIds = (env.ADMIN_IDS || '').split(',').map(id => id.trim());
    const systemAdminId = env.USER.idFromName(adminIds[0]);
    const systemAdminIdStr = systemAdminId.toString();
    const systemAdminCookie = await createSession(systemAdminIdStr);
    
    // 2. Setup Account (System Admin is NOT a member)
    const accId = env.ACCOUNT.newUniqueId();
    const accIdStr = accId.toString();
    const accStub = env.ACCOUNT.get(accId);
    await accStub.updateInfo({ name: 'System Managed Account' });

    // 3. Another user to be added
    const userId = env.USER.newUniqueId().toString();

    // 4. System Admin adds member via API
    const addRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      method: 'POST',
      headers: { 
          'Cookie': systemAdminCookie,
          'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user_id: userId, role: 0 }),
    });
    expect(addRes.status).toBe(200);
    const addData = await addRes.json() as any;
    expect(addData.success).toBe(true);

    // 5. System Admin lists members
    const listRes = await SELF.fetch(`http://example.com/users/api/me/accounts/${accIdStr}/members`, {
      headers: { 'Cookie': systemAdminCookie },
    });
    expect(listRes.status).toBe(200);
    const members = await listRes.json() as any[];
    expect(members.length).toBe(1);
  });
});
