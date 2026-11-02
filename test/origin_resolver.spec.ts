import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { CookieManager } from '../src/CookieManager';
import { createStartupAPI } from '../src/createStartupAPI';
import { AccessPolicy } from '../src/policy/accessPolicy';
import type { OriginResolver } from '../src/schemas/config';

const cookieManager = new CookieManager(env.SESSION_SECRET);

// Reset the global policy so each configured instance re-initializes, and leave it uninitialized
// afterwards so other test files re-init from their own config.
beforeEach(() => AccessPolicy.reset());
afterAll(() => AccessPolicy.reset());

// One deployment in front of several origins: pr-<n>.example.net goes to that PR's origin.
const byHostname: OriginResolver = ({ url }) => {
  const m = url.hostname.match(/^pr-(\d+)\.example\.net$/);
  return m ? `https://pr-${m[1]}.origins.example.org` : null;
};

// Spy globalThis.fetch (the origin). Answers with the URL it was asked for.
function spyOrigin() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const req = input instanceof Request ? input : new Request(input);
    return new Response(`origin:${req.url}`, { status: 200, headers: { 'Content-Type': 'text/plain' } }) as any;
  });
}

function fetchWith(url: string, config: any, init: RequestInit = {}, testEnv: any = { ...env, ORIGIN_URL: '' }) {
  const api = createStartupAPI(config);
  const ctx = createExecutionContext();
  return api.fetch(new Request(url, init), testEnv, ctx).then(async (res) => {
    await waitOnExecutionContext(ctx);
    return res;
  });
}

describe('origin resolver', () => {
  it('sends each request to the origin it picks, with a matching Host', async () => {
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('https://pr-59.example.net/some/page?x=1', { origin: byHostname });
      expect(await res.text()).toBe('origin:https://pr-59.origins.example.org/some/page?x=1');
      const out = fetchSpy.mock.calls[0][0] as Request;
      expect(out.headers.get('Host')).toBe('pr-59.origins.example.org');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers 404 and forwards nothing when it returns no origin', async () => {
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('https://www.example.net/', { origin: byHostname });
      expect(res.status).toBe(404);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("still serves Startup API's own pages when it returns no origin", async () => {
    const res = await fetchWith('https://www.example.net/users/api/me', { origin: byHostname });
    expect(res.status).toBe(401);
  });

  it('takes precedence over ORIGIN_URL, and may be async', async () => {
    const fetchSpy = spyOrigin();
    try {
      const resolver: OriginResolver = async () => new URL('https://async.origins.example.org');
      const res = await fetchWith(
        'https://pr-1.example.net/a',
        { origin: resolver },
        {},
        { ...env, ORIGIN_URL: 'https://fixed.example.org' },
      );
      expect(await res.text()).toBe('origin:https://async.origins.example.org/a');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forwards identity headers to the picked origin', async () => {
    const userId = env.USER.newUniqueId();
    const userStub = env.USER.get(userId);
    const accountIdStr = env.ACCOUNT.newUniqueId().toString();
    await userStub.addMembership(accountIdStr, 1, true);
    const { sessionId } = await userStub.createSession();
    const cookie = await cookieManager.encrypt(`${sessionId}:${userId.toString()}`);

    const fetchSpy = spyOrigin();
    try {
      await fetchWith('https://pr-59.example.net/me-page', { origin: byHostname }, { headers: { Cookie: `session_id=${cookie}` } });
      const out = fetchSpy.mock.calls[0][0] as Request;
      expect(out.headers.get('X-StartupAPI-User-Id')).toBe(userId.toString());
      expect(out.headers.get('X-StartupAPI-Account-Id')).toBe(accountIdStr);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('goes through an ORIGIN service binding when one is configured', async () => {
    const binding = { fetch: vi.fn(async (req: Request) => new Response(`binding:${req.url}`)) };
    const res = await fetchWith('https://pr-7.example.net/x', { origin: byHostname }, {}, { ...env, ORIGIN_URL: '', ORIGIN: binding });
    expect(await res.text()).toBe('binding:https://pr-7.origins.example.org/x');
  });

  it('serves origin-sourced gate pages from the picked origin', async () => {
    const fetchSpy = spyOrigin();
    try {
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
      const res = await fetchWith('https://pr-59.example.net/members', { origin: byHostname, accessPolicy: policy });
      expect(await res.text()).toBe('origin:https://pr-59.origins.example.org/please-log-in');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an origin option that is not a function', () => {
    expect(() => createStartupAPI({ origin: 'https://example.org' } as any)).toThrow();
  });
});
