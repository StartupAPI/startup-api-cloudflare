import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Custom Headers Tests', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  it('should send X-StartupAPI-User-Id and X-StartupAPI-Account-Id headers to origin', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    const accountId = env.ACCOUNT.newUniqueId();
    const accountIdStr = accountId.toString();

    // Create session
    const { sessionId } = await userStub.createSession();

    // Setup membership
    await userStub.addMembership(accountIdStr, 1, true); // 1 = ADMIN, true = current

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${userIdStr}`);

    // Mock global fetch to intercept the call to ORIGIN_URL
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('example.com/some-page')) {
        return new Response('OK', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    try {
      const res = await SELF.fetch('http://example.com/some-page', {
        headers: {
          Cookie: `session_id=${encryptedCookie}`,
        },
      });

      expect(res.status).toBe(200);

      const lastFetchCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastFetchCall).toBeDefined();
      const outboundRequest = lastFetchCall[0] as Request;

      expect(outboundRequest.headers.get('X-StartupAPI-User-Id')).toBe(userIdStr);
      expect(outboundRequest.headers.get('X-StartupAPI-Account-Id')).toBe(accountIdStr);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('should re-issue a persistent session cookie when the session slides (renewal)', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // DO default ttl is 24h; SELF runs createStartupAPI() with the 30-day default, so 24h remaining
    // is below the 15-day (half of 30d) renewal threshold → the proxy response must refresh the cookie.
    const { sessionId } = await userStub.createSession();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${userIdStr}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('example.com/renew-page')) return new Response('OK', { status: 200 });
      return new Response('Not Found', { status: 404 });
    });

    try {
      const res = await SELF.fetch('http://example.com/renew-page', {
        headers: { Cookie: `session_id=${encryptedCookie}` },
      });
      expect(res.status).toBe(200);

      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toContain(`session_id=${encryptedCookie}`);
      expect(setCookie).toContain('Max-Age=2592000'); // 30 days in seconds
      expect(setCookie).toContain('HttpOnly');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('should NOT re-issue the session cookie when the session is well within its window', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const userIdStr = userId.toString();

    // Fresh 30-day session: remaining ~= 30d, far above the 15-day threshold → no renewal cookie.
    const { sessionId } = await userStub.createSession({ provider: 'test' }, 30 * 24 * 60 * 60 * 1000);
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${userIdStr}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('example.com/fresh-page')) return new Response('OK', { status: 200 });
      return new Response('Not Found', { status: 404 });
    });

    try {
      const res = await SELF.fetch('http://example.com/fresh-page', {
        headers: { Cookie: `session_id=${encryptedCookie}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('should NOT send X-StartupAPI headers if no session is present', async () => {
    // Mock global fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('example.com/no-session')) {
        return new Response('OK', { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    });

    try {
      const res = await SELF.fetch('http://example.com/no-session');

      expect(res.status).toBe(200);

      const lastFetchCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
      expect(lastFetchCall).toBeDefined();
      const outboundRequest = lastFetchCall[0] as Request;

      expect(outboundRequest.headers.has('X-StartupAPI-User-Id')).toBe(false);
      expect(outboundRequest.headers.has('X-StartupAPI-Account-Id')).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
