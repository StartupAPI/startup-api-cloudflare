import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('AccountDO Durable Object', () => {
  it('should store and retrieve account info', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Update info
    const infoData = { name: 'Test Account', plan: 'pro' };
    await stub.updateInfo(infoData);

    // Get info
    const data = await stub.getInfo();
    expect(data).toEqual(infoData);
  });

  it('should manage members', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const userId = env.USER.newUniqueId().toString();
    const role = 1; // ADMIN

    // Add member
    await stub.addMember(userId, role);

    // Get members
    const members = await stub.getMembers();
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userId);
    expect(members[0].role).toBe(role);

    // Remove member
    await stub.removeMember(userId);

    // Verify member is removed
    const membersAfter = await stub.getMembers();
    expect(membersAfter).toHaveLength(0);
  });
});
