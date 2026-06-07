import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { CookieManager } from '../src/CookieManager';
import { createStartupAPI } from '../src/createStartupAPI';
import { AccessPolicy } from '../src/policy/accessPolicy';
import type { Gate } from '../src/schemas/policy';

const cookieManager = new CookieManager(env.SESSION_SECRET);

// Reset the global policy so each configured instance re-initializes, and leave it uninitialized
// afterwards so other test files re-init from their own config.
beforeEach(() => AccessPolicy.reset());
afterAll(() => AccessPolicy.reset());

// A path gated behind the "benefit-vip" Patreon perk. Denials are served as in-place gate pages.
function gatePolicy(gate: Gate, on_unauthorized: 'gate' | 'upgrade' | 'login' = 'gate', extra: Record<string, unknown> = {}) {
  return {
    rules: [
      {
        pattern: '/gated',
        requirement: { mode: 'entitlement' as const, provider: 'patreon', condition: { type: 'benefit' as const, benefit_id: 'benefit-vip' } },
        on_unauthorized,
        ...(on_unauthorized === 'gate' ? { gate } : {}),
        ...extra,
      },
    ],
    default: { mode: 'public' as const },
  };
}

function fetchWith(policy: any, path: string, cookie?: string, assetsMock?: (req: Request) => Promise<Response>) {
  const api = createStartupAPI({ accessPolicy: policy });
  const ctx = createExecutionContext();
  const headers: Record<string, string> = cookie ? { Cookie: `session_id=${cookie}` } : {};
  // Override ASSETS only when a mock is provided (asset-sourced gate pages).
  const testEnv = assetsMock ? { ...env, ASSETS: { fetch: vi.fn(assetsMock) } } : env;
  return api.fetch(new Request('http://example.com' + path, { headers }), testEnv as any, ctx).then(async (res) => {
    await waitOnExecutionContext(ctx);
    return res;
  });
}

// Logged-in Patreon user with the given benefits, stored entitlements seeded so no network is needed.
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

// Spy globalThis.fetch (origin proxy). Returns a distinct body per origin path so we can assert which
// page was served.
function spyOrigin() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url).pathname;
    return new Response(`origin:${path}`, { status: 200, headers: { 'Content-Type': 'text/html' } }) as any;
  });
}

// ASSETS mock that returns a distinct body per asset path.
async function assetMock(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  return new Response(`asset:${path}`, { status: 200, headers: { 'Content-Type': 'text/html' } });
}

describe('gate action — serves an explainer page in place', () => {
  it('anonymous visitor → asset variant', async () => {
    const gate: Gate = { anonymous: { asset: '/early-access' } };
    const res = await fetchWith(gatePolicy(gate), '/gated', undefined, assetMock);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/early-access');
  });

  it('anonymous visitor → origin variant (no redirect)', async () => {
    const gate: Gate = { anonymous: { origin: '/early-access' } };
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith(gatePolicy(gate), '/gated');
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('origin:/early-access');
      // It is served in place — no redirect.
      expect(res.headers.has('Location')).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('unentitled (logged-in, lacks benefit) → asset variant', async () => {
    const gate: Gate = { anonymous: { asset: '/early-access' }, unentitled: { asset: '/pledge-needed' } };
    const cookie = await createPatreonUser(['some-other-benefit']);
    const res = await fetchWith(gatePolicy(gate), '/gated', cookie, assetMock);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/pledge-needed');
  });

  it('unentitled (logged-in, lacks benefit) → origin variant', async () => {
    const gate: Gate = { anonymous: { origin: '/early-access' }, unentitled: { origin: '/pledge-needed' } };
    const cookie = await createPatreonUser(['some-other-benefit']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith(gatePolicy(gate), '/gated', cookie);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('origin:/pledge-needed');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('unentitled falls back to anonymous when no unentitled variant is configured', async () => {
    const gate: Gate = { anonymous: { asset: '/early-access' } };
    const cookie = await createPatreonUser(['some-other-benefit']);
    const res = await fetchWith(gatePolicy(gate), '/gated', cookie, assetMock);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('asset:/early-access');
  });

  it('re-stamps a custom status onto the served page', async () => {
    const gate: Gate = { anonymous: { asset: '/early-access' }, status: 403 };
    const res = await fetchWith(gatePolicy(gate), '/gated', undefined, assetMock);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('asset:/early-access');
  });

  it('allows the gated path (no gate page) when the user has the required benefit', async () => {
    const gate: Gate = { anonymous: { asset: '/early-access' } };
    const cookie = await createPatreonUser(['benefit-vip']);
    const fetchSpy = spyOrigin();
    try {
      const res = await fetchWith(gatePolicy(gate), '/gated', cookie);
      expect(res.status).toBe(200);
      // Served from origin (the real page), not the gate asset.
      expect(await res.text()).toContain('origin:/gated');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('gate action — back-compat: omitting gate leaves upgrade/login unchanged', () => {
  it('upgrade still redirects (302) to upgrade_url', async () => {
    const policy = gatePolicy({ anonymous: { asset: '/x' } }, 'upgrade', { upgrade_url: 'https://patreon.com/join' });
    const res = await fetchWith(policy, '/gated');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://patreon.com/join');
  });

  it('login still redirects (302) to authenticate', async () => {
    const policy = gatePolicy({ anonymous: { asset: '/x' } }, 'login');
    const res = await fetchWith(policy, '/gated');
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('return_url=');
  });
});
