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
