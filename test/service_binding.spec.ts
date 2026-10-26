import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { CookieManager } from '../src/CookieManager';
import { createStartupAPI } from '../src/createStartupAPI';
import { AccessPolicy } from '../src/policy/accessPolicy';

const cookieManager = new CookieManager(env.SESSION_SECRET);

// Reset the global policy so each configured instance re-initializes, and leave it uninitialized
// afterwards so other test files re-init from their own config.
beforeEach(() => AccessPolicy.reset());
afterAll(() => AccessPolicy.reset());

// A stand-in for the ORIGIN service binding: records each request and answers with its path.
function originBinding() {
  return {
    fetch: vi.fn(async (req: Request) => new Response(`binding:${new URL(req.url).pathname}`, { status: 200 })),
  };
}

function fetchWith(testEnv: any, path: string, init: RequestInit = {}, config: any = {}) {
  const api = createStartupAPI(config);
  const ctx = createExecutionContext();
  return api.fetch(new Request('https://app.example.org' + path, init), testEnv, ctx).then(async (res) => {
    await waitOnExecutionContext(ctx);
    return res;
  });
}

describe('ORIGIN service binding', () => {
  it('proxies through the binding instead of the public internet', async () => {
    const binding = originBinding();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await fetchWith({ ...env, ORIGIN: binding, ORIGIN_URL: '' }, '/some-page');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('binding:/some-page');
      expect(binding.fetch).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('keeps the public URL and Host when no ORIGIN_URL is set', async () => {
    const binding = originBinding();
    await fetchWith({ ...env, ORIGIN: binding, ORIGIN_URL: '' }, '/page?x=1');

    const out = binding.fetch.mock.calls[0][0] as Request;
    expect(out.url).toBe('https://app.example.org/page?x=1');
    expect(out.headers.get('Host')).toBe('app.example.org');
  });

  it('still points the request at ORIGIN_URL when both are set', async () => {
    const binding = originBinding();
    await fetchWith({ ...env, ORIGIN: binding, ORIGIN_URL: 'https://origin.example.net' }, '/page');

    const out = binding.fetch.mock.calls[0][0] as Request;
    expect(out.url).toBe('https://origin.example.net/page');
    expect(out.headers.get('Host')).toBe('origin.example.net');
  });

  it('forwards identity headers through the binding', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountIdStr = env.ACCOUNT.newUniqueId().toString();
    await userStub.addMembership(accountIdStr, 1, true);
    const { sessionId } = await userStub.createSession();
    const cookie = await cookieManager.encrypt(`${sessionId}:${userId.toString()}`);

    const binding = originBinding();
    await fetchWith({ ...env, ORIGIN: binding, ORIGIN_URL: '' }, '/me-page', { headers: { Cookie: `session_id=${cookie}` } });

    const out = binding.fetch.mock.calls[0][0] as Request;
    expect(out.headers.get('X-StartupAPI-User-Id')).toBe(userId.toString());
    expect(out.headers.get('X-StartupAPI-Account-Id')).toBe(accountIdStr);
  });

  it('serves origin-sourced gate pages through the binding', async () => {
    const binding = originBinding();
    const policy = {
      rules: [
        {
          pattern: '/members',
          requirement: { mode: 'authenticated' as const },
          on_unauthorized: 'gate' as const,
          gate: { anonymous: { origin: '/please-log-in' } },
        },
      ],
      default: { mode: 'public' as const },
    };
    const res = await fetchWith({ ...env, ORIGIN: binding, ORIGIN_URL: '' }, '/members', {}, { accessPolicy: policy });

    expect(await res.text()).toBe('binding:/please-log-in');
    const out = binding.fetch.mock.calls[0][0] as Request;
    expect(out.url).toBe('https://app.example.org/please-log-in');
  });
});
