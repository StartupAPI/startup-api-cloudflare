import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('UserDO Durable Object', () => {
  it('should store and retrieve profile', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Update profile
    const profileData = { name: 'Test User', email: 'test@example.com' };
    let res = await stub.fetch('http://do/profile', {
      method: 'POST',
      body: JSON.stringify(profileData),
    });
    expect(res.status).toBe(200);
    await res.json(); // Drain body

    // Get profile
    res = await stub.fetch('http://do/profile');
    const data = await res.json();
    expect(data).toEqual(profileData);
  });

  it('should create session', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const res = await stub.fetch('http://do/sessions', {
      method: 'POST',
    });
    const data: any = await res.json();
    expect(data).toHaveProperty('sessionId');
    expect(data).toHaveProperty('expiresAt');
  });
});
