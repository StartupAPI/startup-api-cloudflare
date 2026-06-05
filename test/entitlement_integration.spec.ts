import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { CookieManager } from '../src/CookieManager';
import { createStartupAPI } from '../src/createStartupAPI';
import { AccessPolicy } from '../src/policy/accessPolicy';

const cookieManager = new CookieManager(env.SESSION_SECRET);

// Access policy is now factory config (not env): /special requires the "benefit-vip" perk, /raw is bypass.
const POLICY = {
  rules: [
    {
      pattern: '/special',
      requirement: { mode: 'entitlement' as const, provider: 'patreon', condition: { type: 'benefit' as const, benefit_id: 'benefit-vip' } },
      on_unauthorized: 'forbidden' as const,
    },
    { pattern: '/raw', requirement: { mode: 'bypass' as const } },
  ],
  default: { mode: 'public' as const },
};

// Reset the global policy so each configured instance re-initializes with POLICY,
// and leave it uninitialized afterwards so other test files re-init from their own config.
beforeEach(() => AccessPolicy.reset());
afterAll(() => AccessPolicy.reset());

function fetchWith(path: string, cookie?: string) {
  const api = createStartupAPI({ accessPolicy: POLICY });
  const ctx = createExecutionContext();
  const headers: Record<string, string> = cookie ? { Cookie: `session_id=${cookie}` } : {};
  return api.fetch(new Request('http://example.com' + path, { headers }), env, ctx).then(async (res) => {
    await waitOnExecutionContext(ctx);
    return res;
  });
}

async function createPatreonUser(benefits: string[], active = true, userId = env.USER.newUniqueId()) {
  const userStub = env.USER.get(userId);
  const userIdStr = userId.toString();
  const subjectId = 'patreon-' + userIdStr.slice(0, 10);

  await userStub.addMembership(env.ACCOUNT.newUniqueId().toString(), 1, true);
  await userStub.addCredential('patreon', subjectId);
  const { sessionId } = await userStub.createSession({ provider: 'patreon' });

  const entitlements = {
    provider: 'patreon',
    checked_at: Date.now(),
    source: 'oauth',
    patreon: {
      patron_status: active ? 'active_patron' : 'former_patron',
      is_active_patron: active,
      entitled_tier_ids: ['t1'],
      entitled_benefit_ids: benefits,
      pledge_amount_cents: 500,
    },
  };
  await userStub.setEntitlements('patreon', subjectId, entitlements, entitlements.checked_at);

  return cookieManager.encrypt(`${sessionId}:${userIdStr}`);
}

function spyOrigin() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('example.com')) {
      return new Response('<html><body>origin</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) as any;
    }
    return new Response('nf', { status: 404 }) as any;
  });
}

describe('Entitlement headers + access policy', () => {
  it('forwards login + entitlement headers to origin for a Patreon user on a public path', async () => {
    const cookie = await createPatreonUser(['benefit-vip']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('/dashboard', cookie);
      expect(res.status).toBe(200);

      const out = fetchSpy.mock.calls.at(-1)![0] as Request;
      expect(out.headers.get('X-StartupAPI-Authenticated')).toBe('true');
      expect(out.headers.get('X-StartupAPI-Login-Provider')).toBe('patreon');
      expect(out.headers.get('X-StartupAPI-Patreon-Active')).toBe('true');
      expect(out.headers.get('X-StartupAPI-Patreon-Benefits')).toContain('benefit-vip');
      const ent = JSON.parse(out.headers.get('X-StartupAPI-Entitlements')!);
      expect(ent.patreon.entitled_benefit_ids).toContain('benefit-vip');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('allows a gated path when the user has the required benefit', async () => {
    const cookie = await createPatreonUser(['benefit-vip']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('/special', cookie);
      expect(res.status).toBe(200);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forbids a gated path when the user lacks the required benefit', async () => {
    const cookie = await createPatreonUser(['some-other-benefit']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('/special', cookie);
      expect(res.status).toBe(403);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forbids a gated path for an unauthenticated request', async () => {
    const res = await fetchWith('/special');
    expect(res.status).toBe(403);
  });

  it('lets an admin reach a gated path even without the required benefit', async () => {
    // ADMIN_IDS is "admin" in the test env; in test mode isAdmin() resolves names via idFromName().
    const cookie = await createPatreonUser(['some-other-benefit'], true, env.USER.idFromName('admin'));
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('/special', cookie);
      expect(res.status).toBe(200);

      // Identity is still resolved and headers forwarded — only the gate is bypassed.
      const out = fetchSpy.mock.calls.at(-1)![0] as Request;
      expect(out.headers.get('X-StartupAPI-Authenticated')).toBe('true');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('bypass path forwards with NO X-StartupAPI headers and no power-strip injection, even when logged in', async () => {
    const cookie = await createPatreonUser(['benefit-vip']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith('/raw', cookie);
      expect(res.status).toBe(200);

      const out = fetchSpy.mock.calls.at(-1)![0] as Request;
      expect(out.headers.has('X-StartupAPI-User-Id')).toBe(false);
      expect(out.headers.has('X-StartupAPI-Authenticated')).toBe(false);
      expect(out.headers.has('X-StartupAPI-Entitlements')).toBe(false);

      const body = await res.text();
      expect(body).not.toContain('power-strip');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
