import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('AccountDO Durable Object', () => {
  it('should store and retrieve account info', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    // Update info
    const infoData = { name: 'Test Account', plan: 'pro' };
    let res = await stub.fetch('http://do/info', {
      method: 'POST',
      body: JSON.stringify(infoData),
    });
    expect(res.status).toBe(200);
    await res.json(); // Drain body

    // Get info
    res = await stub.fetch('http://do/info');
    const data = await res.json();
    expect(data).toEqual(infoData);
  });

  it('should manage members', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const userId = 'user-123';
    const role = 1; // ADMIN

    // Add member
    let res = await stub.fetch('http://do/members', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, role }),
    });
    expect(res.status).toBe(200);

    // Get members
    res = await stub.fetch('http://do/members');
    const members: any[] = await res.json();
    expect(members).toHaveLength(1);
    expect(members[0].user_id).toBe(userId);
    expect(members[0].role).toBe(role);

    // Remove member
    res = await stub.fetch(`http://do/members/${userId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // Verify member is removed
    res = await stub.fetch('http://do/members');
    const membersAfter: any[] = await res.json();
    expect(membersAfter).toHaveLength(0);
  });
});
