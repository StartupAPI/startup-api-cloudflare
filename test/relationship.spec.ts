import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { AccountDO } from '../src/AccountDO';

describe('User-Account Relationship', () => {
  it('should sync membership when adding user to account', async () => {
    const userId = env.USER.newUniqueId();
    const accountId = env.ACCOUNT.newUniqueId();
    const accountStub = env.ACCOUNT.get(accountId);
    const userStub = env.USER.get(userId);

    // Add user to account
    const addRes = await accountStub.fetch('http://do/members', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId.toString(), role: AccountDO.ROLE_ADMIN }),
    });
    expect(addRes.status).toBe(200);

    // Verify UserDO has membership
    const memRes = await userStub.fetch('http://do/memberships');
    const memberships: any[] = await memRes.json();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].account_id).toBe(accountId.toString());
    expect(memberships[0].role).toBe(AccountDO.ROLE_ADMIN);
  });

  it('should sync membership removal', async () => {
    const userId = env.USER.newUniqueId();
    const accountId = env.ACCOUNT.newUniqueId();
    const accountStub = env.ACCOUNT.get(accountId);
    const userStub = env.USER.get(userId);

    // Add user first
    await accountStub.fetch('http://do/members', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId.toString(), role: AccountDO.ROLE_ADMIN }),
    });

    // Remove user
    const delRes = await accountStub.fetch(`http://do/members/${userId.toString()}`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);

    // Verify UserDO has NO membership
    const memRes = await userStub.fetch('http://do/memberships');
    const memberships: any[] = await memRes.json();
    expect(memberships).toHaveLength(0);
  });

  it('should switch accounts', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountId1 = env.ACCOUNT.newUniqueId().toString();
    const accountId2 = env.ACCOUNT.newUniqueId().toString();

    // Add memberships directly to UserDO for this test (or via AccountDO)
    await userStub.fetch('http://do/memberships', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId1, role: AccountDO.ROLE_ADMIN, is_current: true }),
    });
    await userStub.fetch('http://do/memberships', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId2, role: AccountDO.ROLE_ADMIN, is_current: false }),
    });

    // Verify initial state
    let memRes = await userStub.fetch('http://do/memberships');
    let memberships: any[] = await memRes.json();
    expect(memberships.find((m) => m.account_id === accountId1).is_current).toBe(1);
    expect(memberships.find((m) => m.account_id === accountId2).is_current).toBe(0);

    // Switch to Account 2
    const switchRes = await userStub.fetch('http://do/switch-account', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId2 }),
    });
    expect(switchRes.status).toBe(200);

    // Verify state
    memRes = await userStub.fetch('http://do/memberships');
    memberships = await memRes.json();
    expect(memberships.find((m) => m.account_id === accountId1).is_current).toBe(0);
    expect(memberships.find((m) => m.account_id === accountId2).is_current).toBe(1);
  });

  it('should retrieve current account', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountId = env.ACCOUNT.newUniqueId().toString();

    // Add membership
    await userStub.fetch('http://do/memberships', {
      method: 'POST',
      body: JSON.stringify({ account_id: accountId, role: AccountDO.ROLE_ADMIN, is_current: true }),
    });

    // Get current account
    const res = await userStub.fetch('http://do/current-account');
    expect(res.status).toBe(200);
    const current: any = await res.json();
    expect(current).toHaveProperty('account_id', accountId);
    expect(current).toHaveProperty('role', AccountDO.ROLE_ADMIN);
  });
});
