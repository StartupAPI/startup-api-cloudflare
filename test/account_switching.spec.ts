import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Account Switching Integration', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  it('should list accounts and switch between them', async () => {
    // 1. Setup User and Session
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    const { sessionId } = await userStub.createSession();
    const cookieHeader = `session_id=${await cookieManager.encrypt(`${sessionId}:${userIdStr}`)}`;

    // 2. Setup Accounts
    // Account 1 (Personal)
    const acc1Id = env.ACCOUNT.newUniqueId();
    const acc1Stub = env.ACCOUNT.get(acc1Id);
    const acc1IdStr = acc1Id.toString();

    await acc1Stub.updateInfo({ name: 'Personal Account', personal: true });
    // Add user to Account 1
    await acc1Stub.addMember(userIdStr, 1);
    // Add membership to User (Current)
    await userStub.addMembership(acc1IdStr, 1, true);

    // Account 2 (Team)
    const acc2Id = env.ACCOUNT.newUniqueId();
    const acc2Stub = env.ACCOUNT.get(acc2Id);
    const acc2IdStr = acc2Id.toString();

    await acc2Stub.updateInfo({ name: 'Team Account', personal: false });
    // Add user to Account 2
    await acc2Stub.addMember(userIdStr, 0);
    // Add membership to User (Not Current)
    await userStub.addMembership(acc2IdStr, 0, false);

    // 3. Test GET /users/api/me/accounts
    const listRes = await SELF.fetch('http://example.com/users/api/me/accounts', {
      headers: { Cookie: cookieHeader },
    });
    expect(listRes.status).toBe(200);
    const accounts = (await listRes.json()) as any[];
    expect(accounts.length).toBe(2);
    const acc1 = accounts.find((a) => a.account_id === acc1IdStr);
    const acc2 = accounts.find((a) => a.account_id === acc2IdStr);

    expect(acc1.name).toBe('Personal Account');
    expect(acc1.is_current).toBe(1); // SQLite boolean as integer
    expect(acc2.name).toBe('Team Account');
    expect(acc2.is_current).toBe(0);

    // 4. Test Switch to Account 2
    const switchRes = await SELF.fetch('http://example.com/users/api/me/accounts/switch', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: JSON.stringify({ account_id: acc2IdStr }),
    });
    expect(switchRes.status).toBe(200);

    // 5. Verify Switch via /users/api/me
    const meRes = await SELF.fetch('http://example.com/users/api/me', {
      headers: { Cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const meData = (await meRes.json()) as any;
    expect(meData.account.id).toBe(acc2IdStr);
    expect(meData.account.name).toBe('Team Account');

    // 6. Verify List reflects change
    const listRes2 = await SELF.fetch('http://example.com/users/api/me/accounts', {
      headers: { Cookie: cookieHeader },
    });
    const accounts2 = (await listRes2.json()) as any[];
    const acc1_after = accounts2.find((a) => a.account_id === acc1IdStr);
    const acc2_after = accounts2.find((a) => a.account_id === acc2IdStr);

    expect(acc1_after.is_current).toBe(0);
    expect(acc2_after.is_current).toBe(1);
  });
});
