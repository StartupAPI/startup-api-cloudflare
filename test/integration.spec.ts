import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Integration Tests', () => {
  it('should return 401 for /me without cookie', async () => {
    const res = await SELF.fetch('http://example.com/users/me');
    expect(res.status).toBe(401);
  });

  it('should return user profile for valid session', async () => {
    // 1. Manually set up a UserDO with a session
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    
    // Create session
    const sessionRes = await stub.fetch('http://do/sessions', { method: 'POST' });
    const { sessionId } = await sessionRes.json() as any;

    // Add some credentials/profile data
    const credsRes = await stub.fetch('http://do/credentials', {
        method: 'POST',
        body: JSON.stringify({
            provider: 'test-provider',
            subject_id: '123',
            profile_data: { name: 'Integration Tester' }
        })
    });
    await credsRes.json(); // Drain body

    // 2. Fetch /me with the cookie
    const doId = id.toString();
    const res = await SELF.fetch('http://example.com/users/me', {
        headers: {
            'Cookie': `session_id=${sessionId}:${doId}`
        }
    });

    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.valid).toBe(true);
    expect(data.profile.name).toBe('Integration Tester');
  });

  it('should serve avatar image from /me/avatar', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    
    // Create session
    const sessionRes = await stub.fetch('http://do/sessions', { method: 'POST' });
    const { sessionId } = (await sessionRes.json()) as any;

    // Store a fake image
    const imageData = new Uint8Array([1, 2, 3, 4]);
    const storeRes = await stub.fetch('http://do/images/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': 'image/png' },
        body: imageData
    });
    await storeRes.json(); // Drain body

    // Fetch image via worker
    const doId = id.toString();
    const res = await SELF.fetch('http://example.com/users/me/avatar', {
        headers: {
            'Cookie': `session_id=${sessionId}:${doId}`
        }
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buffer = await res.arrayBuffer();
    expect(new Uint8Array(buffer)).toEqual(imageData);
  });
});
