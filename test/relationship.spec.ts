import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { AccountDO } from '../src/storage/AccountDO';

describe('User-Account Relationship', () => {
  it('should sync membership when adding user to account', async () => {
    const userId = env.USER.newUniqueId();
    const accountId = env.ACCOUNT.newUniqueId();
    const accountStub = env.ACCOUNT.get(accountId);
    const userStub = env.USER.get(userId);

    // Add user to account
    await accountStub.addMember(userId.toString(), AccountDO.ROLE_ADMIN);

    // Verify UserDO has membership
    const memberships = await userStub.getMemberships();
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
    await accountStub.addMember(userId.toString(), AccountDO.ROLE_ADMIN);

    // Remove user
    await accountStub.removeMember(userId.toString());

    // Verify UserDO has NO membership
    const memberships = await userStub.getMemberships();
    expect(memberships).toHaveLength(0);
  });

  it('should switch accounts', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountId1 = env.ACCOUNT.newUniqueId().toString();
    const accountId2 = env.ACCOUNT.newUniqueId().toString();

    // Add memberships directly to UserDO for this test (or via AccountDO)
    await userStub.addMembership(accountId1, AccountDO.ROLE_ADMIN, true);
    await userStub.addMembership(accountId2, AccountDO.ROLE_ADMIN, false);

    // Verify initial state
    let memberships = await userStub.getMemberships();
    expect(memberships.find((m: any) => m.account_id === accountId1).is_current).toBe(1);
    expect(memberships.find((m: any) => m.account_id === accountId2).is_current).toBe(0);

    // Switch to Account 2
    await userStub.switchAccount(accountId2);

    // Verify state
    memberships = await userStub.getMemberships();
    expect(memberships.find((m: any) => m.account_id === accountId1).is_current).toBe(0);
    expect(memberships.find((m: any) => m.account_id === accountId2).is_current).toBe(1);
  });

  it('should retrieve current account', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountId = env.ACCOUNT.newUniqueId().toString();

    // Add membership
    await userStub.addMembership(accountId, AccountDO.ROLE_ADMIN, true);

    // Get current account
    const current: any = await userStub.getCurrentAccount();
    expect(current).toHaveProperty('account_id', accountId);
    expect(current).toHaveProperty('role', AccountDO.ROLE_ADMIN);
  });
});
