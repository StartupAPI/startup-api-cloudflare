import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Feature, hasFeature } from '../src/features/Feature';
import {
  resolveUserFeatures,
  resolveAccountFeatures,
  resolveAnonymousFeatures,
  staticallyEnabledFeatureIds,
  enabledIds,
  deltaTokens,
} from '../src/features/resolve';
import { FeatureDeliverySchema, FeaturesConfigSchema } from '../src/schemas/feature';
import { Plan } from '../src/billing/Plan';
import { AccessPolicy, evaluateAccess } from '../src/policy/accessPolicy';
import { createStartupAPI } from '../src/createStartupAPI';
import { CookieManager } from '../src/CookieManager';
import type { FeatureConfig } from '../src/schemas/feature';
import type { AccessRule } from '../src/schemas/policy';

const FEATURES: FeatureConfig[] = [
  { id: 'rolled_out', name: 'Rolled out', rolled_out_to_all_users: true },
  { id: 'disabled', name: 'Disabled', enabled: false, rolled_out_to_all_users: true },
  { id: 'shutdown', name: 'Shut down', rolled_out_to_all_users: true, emergency_shutdown: true },
  { id: 'pro_reports', name: 'Pro reports' },
  { id: 'beta', name: 'Beta' },
];

const PLANS = [
  { slug: 'free', name: 'Free' },
  { slug: 'pro', name: 'Pro', features: ['pro_reports'] },
];

function initRegistries() {
  Feature.reset();
  Plan.clear();
  AccessPolicy.reset();
  Feature.init(FEATURES);
  Plan.init(PLANS);
}

// Leave the singletons uninitialized so the default worker re-inits them in other test files.
afterAll(() => {
  Feature.reset();
  Plan.clear();
  AccessPolicy.reset();
});

async function newAccount(plan?: string): Promise<string> {
  const id = env.ACCOUNT.newUniqueId();
  if (plan) await env.ACCOUNT.get(id).updateInfo({ plan });
  return id.toString();
}

async function newUserInAccount(accountId?: string): Promise<string> {
  const id = env.USER.newUniqueId();
  if (accountId) await env.USER.get(id).addMembership(accountId, 1, true);
  return id.toString();
}

describe('Feature config', () => {
  it('applies defaults', () => {
    const [f] = FeaturesConfigSchema.parse([{ id: 'x', name: 'X' }]);
    expect(f).toEqual({ id: 'x', name: 'X', enabled: true, rolled_out_to_all_users: false, emergency_shutdown: false });
  });

  it('rejects duplicate ids', () => {
    expect(() =>
      FeaturesConfigSchema.parse([
        { id: 'x', name: 'X' },
        { id: 'x', name: 'X2' },
      ]),
    ).toThrow(/Duplicate feature id 'x'/);
  });

  it('keeps an optional description', () => {
    const [f] = FeaturesConfigSchema.parse([{ id: 'x', name: 'X', description: 'Does X.' }]);
    expect(f.description).toBe('Does X.');
    Feature.reset();
    Feature.init([{ id: 'x', name: 'X', description: 'Does X.' }]);
    expect(Feature.require('x').description).toBe('Does X.');
    Feature.reset();
  });

  it('defaults feature delivery to a delta header and no HTML changes', () => {
    expect(FeatureDeliverySchema.parse({})).toEqual({ header: 'delta', html: false });
    expect(() => FeatureDeliverySchema.parse({ header: 'all' })).toThrow();
  });

  it('rejects invalid ids', () => {
    expect(() => FeaturesConfigSchema.parse([{ id: 'New Dashboard', name: 'X' }])).toThrow(/Feature id/);
  });

  it('rejects an invalid features config at factory construction', () => {
    expect(() =>
      createStartupAPI({
        features: [
          { id: 'x', name: 'X' },
          { id: 'x', name: 'Y' },
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it('computes the static state from the global switches', () => {
    initRegistries();
    expect(Feature.require('rolled_out').staticState()).toBe('on');
    expect(Feature.require('disabled').staticState()).toBe('off');
    expect(Feature.require('shutdown').staticState()).toBe('off');
    expect(Feature.require('beta').staticState()).toBe('contextual');
    expect(staticallyEnabledFeatureIds(Feature.getAll())).toEqual(['rolled_out']);
    expect(() => Feature.require('nope')).toThrow(/Unknown feature 'nope'/);
  });
});

describe('Feature delta', () => {
  beforeEach(initRegistries);

  it('sends only kill switches for anonymous visitors', () => {
    const all = Feature.getAll();
    expect(deltaTokens(all, resolveAnonymousFeatures(all))).toEqual(['-disabled', '-shutdown']);
  });

  it('adds contextual features that are on, and nothing for rolled-out features that are on', () => {
    const all = Feature.getAll();
    const resolutions = resolveAnonymousFeatures(all).map((r) =>
      r.id === 'beta' ? { ...r, enabled: true, source: 'override' as const } : r,
    );
    expect(deltaTokens(all, resolutions)).toEqual(['-disabled', '-shutdown', 'beta']);
  });

  it('is empty when every feature is at its baseline', () => {
    Feature.reset();
    Feature.init([
      { id: 'on', name: 'On', rolled_out_to_all_users: true },
      { id: 'off', name: 'Off' },
    ]);
    const all = Feature.getAll();
    expect(deltaTokens(all, resolveAnonymousFeatures(all))).toEqual([]);
  });
});

describe('Feature resolution', () => {
  beforeEach(initRegistries);

  it('resolves static features without reading any Durable Object', async () => {
    const userGet = vi.spyOn(env.USER, 'get');
    const accountGet = vi.spyOn(env.ACCOUNT, 'get');
    try {
      const statics = Feature.getAll().filter((f) => f.staticState() !== 'contextual');
      const userId = env.USER.newUniqueId().toString();
      const res = await resolveUserFeatures(env, userId, statics);
      expect(enabledIds(res)).toEqual(['rolled_out']);
      expect(res.every((r) => r.source === 'static')).toBe(true);
      expect(await resolveAccountFeatures(env, env.ACCOUNT.newUniqueId().toString(), statics)).toHaveLength(3);
      expect(userGet).not.toHaveBeenCalled();
      expect(accountGet).not.toHaveBeenCalled();
    } finally {
      userGet.mockRestore();
      accountGet.mockRestore();
    }
  });

  it('grants a feature through the account plan', async () => {
    const proAccount = await newAccount('pro');
    const freeAccount = await newAccount();
    const feature = Feature.require('pro_reports');
    expect(await feature.isEnabledForAccount(env, proAccount)).toBe(true);
    expect(await feature.isEnabledForAccount(env, freeAccount)).toBe(false);
    const [resolution] = (await resolveAccountFeatures(env, proAccount, [feature])).filter((r) => r.id === 'pro_reports');
    expect(resolution.source).toBe('plan');
  });

  it('enables and removes an account override', async () => {
    const accountId = await newAccount();
    const beta = Feature.require('beta');
    await beta.enableForAccount(env, accountId);
    expect(await beta.isEnabledForAccount(env, accountId)).toBe(true);
    await beta.removeForAccount(env, accountId);
    expect(await beta.isEnabledForAccount(env, accountId)).toBe(false);
  });

  it('enables and removes a user override', async () => {
    const userId = await newUserInAccount();
    const beta = Feature.require('beta');
    await beta.enableForUser(env, userId);
    expect(await hasFeature(env, userId, 'beta')).toBe(true);
    await beta.removeForUser(env, userId);
    expect(await hasFeature(env, userId, 'beta')).toBe(false);
  });

  it('lets a user inherit features from the current account, following account switches', async () => {
    const proAccount = await newAccount('pro');
    const freeAccount = await newAccount();
    const userId = await newUserInAccount(proAccount);
    await env.USER.get(env.USER.idFromString(userId)).addMembership(freeAccount, 1, false);

    const res = await resolveUserFeatures(env, userId, Feature.getAll());
    expect(res.find((r) => r.id === 'pro_reports')).toEqual({ id: 'pro_reports', enabled: true, source: 'account' });

    await env.USER.get(env.USER.idFromString(userId)).switchAccount(freeAccount);
    expect(await hasFeature(env, userId, 'pro_reports')).toBe(false);
  });

  it('lets the emergency shutdown and global switch beat overrides', async () => {
    const userId = await newUserInAccount();
    const userStub = env.USER.get(env.USER.idFromString(userId));
    await userStub.setFeatureOverride('shutdown', true);
    await userStub.setFeatureOverride('disabled', true);
    expect(await hasFeature(env, userId, 'shutdown')).toBe(false);
    expect(await hasFeature(env, userId, 'disabled')).toBe(false);
  });

  it('returns results in feature config order', async () => {
    const userId = await newUserInAccount(await newAccount('pro'));
    await Feature.require('beta').enableForUser(env, userId);
    const res = await resolveUserFeatures(env, userId, Feature.getAll());
    expect(res.map((r) => r.id)).toEqual(FEATURES.map((f) => f.id));
    expect(enabledIds(res)).toEqual(['rolled_out', 'pro_reports', 'beta']);
  });

  it('throws from hasFeature for an unknown feature', async () => {
    await expect(hasFeature(env, env.USER.newUniqueId().toString(), 'nope')).rejects.toThrow(/Unknown feature/);
  });
});

describe('Feature usage counts', () => {
  beforeEach(initRegistries);

  it('counts overrides and drops them when the user or account is deleted', async () => {
    const beta = Feature.require('beta');
    const before = { users: await beta.getUserCount(env), accounts: await beta.getAccountCount(env) };

    const userId = await newUserInAccount();
    const accountId = await newAccount();
    await beta.enableForUser(env, userId);
    await beta.enableForUser(env, userId); // idempotent
    await beta.enableForAccount(env, accountId);
    expect(await beta.getUserCount(env)).toBe(before.users + 1);
    expect(await beta.getAccountCount(env)).toBe(before.accounts + 1);

    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.deleteUser(userId);
    await systemStub.deleteAccount(accountId);
    expect(await beta.getUserCount(env)).toBe(before.users);
    expect(await beta.getAccountCount(env)).toBe(before.accounts);
  });
});

describe('Access policy feature mode', () => {
  beforeEach(initRegistries);

  const rule = (feature: string): AccessRule => ({
    pattern: '/x',
    requirement: { mode: 'feature', feature },
    on_unauthorized: 'forbidden',
  });

  it('allows visitors that have the feature', () => {
    expect(evaluateAccess(rule('beta'), { authenticated: true, entitlements: null, features: new Set(['beta']) }).allow).toBe(true);
    expect(evaluateAccess(rule('rolled_out'), { authenticated: false, entitlements: null, features: new Set(['rolled_out']) }).allow).toBe(
      true,
    );
  });

  it('denies logged-in users without the feature as not entitled, anonymous ones as unauthenticated', () => {
    expect(evaluateAccess(rule('beta'), { authenticated: true, entitlements: null, features: new Set() })).toMatchObject({
      allow: false,
      reason: 'not_entitled',
    });
    expect(evaluateAccess(rule('beta'), { authenticated: false, entitlements: null })).toMatchObject({
      allow: false,
      reason: 'unauthenticated',
    });
  });

  it('applies to admins too (no admin bypass for features)', () => {
    expect(evaluateAccess(rule('beta'), { authenticated: true, entitlements: null, isAdmin: true, features: new Set() })).toMatchObject({
      allow: false,
      reason: 'not_entitled',
    });
    expect(
      evaluateAccess(rule('beta'), { authenticated: true, entitlements: null, isAdmin: true, features: new Set(['beta']) }).allow,
    ).toBe(true);
  });

  it('rejects an unknown feature at init', () => {
    expect(() => AccessPolicy.init({ rules: [{ pattern: '/x', requirement: { mode: 'feature', feature: 'nope' } }] })).toThrow(
      /unknown feature 'nope'/,
    );
  });
});

describe('Features over HTTP', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  // Pre-initialize features and plans: AccountDO's constructor fills an empty Plan registry with the
  // default plans, which would otherwise win over the factory's `plans` when an account is created
  // before the first request. The factory still initializes the access policy.
  beforeEach(initRegistries);

  const config = {
    features: FEATURES,
    plans: PLANS,
    accessPolicy: {
      default: { mode: 'public' as const },
      rules: [{ pattern: '/beta/*', requirement: { mode: 'feature' as const, feature: 'beta' }, on_unauthorized: 'forbidden' as const }],
    },
  };

  async function sessionCookie(userId: string): Promise<string> {
    const { sessionId } = await env.USER.get(env.USER.idFromString(userId)).createSession({ provider: 'test' });
    return `session_id=${await cookieManager.encrypt(`${sessionId}:${userId}`)}`;
  }

  // Run a request through a configured instance; return the response and the request the origin got.
  async function proxy(
    api: ReturnType<typeof createStartupAPI>,
    path: string,
    headers: Record<string, string> = {},
    origin: () => Response = () => new Response('OK', { status: 200 }),
  ) {
    let originRequest: Request | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      originRequest = new Request(input as RequestInfo, init);
      return origin();
    });
    try {
      const ctx = createExecutionContext();
      const res = await api.fetch(new Request(`http://example.com${path}`, { headers }), env, ctx);
      await waitOnExecutionContext(ctx);
      return { res, originRequest };
    } finally {
      fetchSpy.mockRestore();
    }
  }

  it('forwards the delta from the baselines to the origin and strips a spoofed header', async () => {
    const api = createStartupAPI(config);
    const userId = await newUserInAccount(await newAccount('pro'));
    const { originRequest } = await proxy(api, '/page', { Cookie: await sessionCookie(userId), 'X-StartupAPI-Features': 'beta' });
    expect(originRequest?.headers.get('X-StartupAPI-Features')).toBe('-disabled,-shutdown,pro_reports');
  });

  it('forwards only kill switches for anonymous visitors', async () => {
    const api = createStartupAPI(config);
    const { originRequest } = await proxy(api, '/page', { 'X-StartupAPI-Features': 'beta' });
    expect(originRequest?.headers.get('X-StartupAPI-Features')).toBe('-disabled,-shutdown');
  });

  it("forwards every enabled feature with header: 'enabled'", async () => {
    const api = createStartupAPI({ ...config, featureDelivery: { header: 'enabled' } });
    const userId = await newUserInAccount(await newAccount('pro'));
    const { originRequest } = await proxy(api, '/page', { Cookie: await sessionCookie(userId) });
    expect(originRequest?.headers.get('X-StartupAPI-Features')).toBe('rolled_out,pro_reports');
  });

  it("sends no features header with header: 'none'", async () => {
    const api = createStartupAPI({ ...config, featureDelivery: { header: 'none' } });
    const { originRequest } = await proxy(api, '/page', { 'X-StartupAPI-Features': 'beta' });
    expect(originRequest?.headers.has('X-StartupAPI-Features')).toBe(false);
  });

  describe('in HTML', () => {
    const PAGE =
      '<!doctype html><html lang="en"><head></head><body>' +
      '<button data-startupapi-feature="beta" data-startupapi-feature-off>Beta</button>' +
      '<button data-startupapi-feature="rolled_out">Rolled out</button>' +
      '<button data-startupapi-feature="shutdown">Shut down</button>' +
      '<button data-startupapi-feature="unknown" data-startupapi-feature-off>Unknown</button>' +
      '</body></html>';
    const html = () =>
      new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } });

    it('leaves the page alone by default', async () => {
      const api = createStartupAPI(config);
      const { res } = await proxy(api, '/page', {}, html);
      const body = await res.text();
      expect(body).not.toContain('data-startupapi-features=');
      expect(body).toContain('<button data-startupapi-feature="beta" data-startupapi-feature-off>');
      expect(body).toContain('<button data-startupapi-feature="shutdown">');
    });

    it('writes an empty delta and gates elements for anonymous visitors', async () => {
      Feature.reset();
      Feature.init([
        { id: 'rolled_out', name: 'Rolled out', rolled_out_to_all_users: true },
        { id: 'shutdown', name: 'Shut down', rolled_out_to_all_users: true, emergency_shutdown: true },
        { id: 'beta', name: 'Beta' },
      ]);
      const api = createStartupAPI({ ...config, features: undefined, plans: undefined, featureDelivery: { html: true } });
      const { res } = await proxy(api, '/page', {}, html);
      const body = await res.text();
      expect(body).toContain('<html lang="en" data-startupapi-features="-shutdown">');
      expect(body).toContain('<button data-startupapi-feature="beta" data-startupapi-feature-off>');
      expect(body).toContain('<button data-startupapi-feature="rolled_out">');
      expect(body).toContain('<button data-startupapi-feature="shutdown" data-startupapi-feature-off="">');
      // Ids the proxy doesn't know are left as the origin sent them.
      expect(body).toContain('<button data-startupapi-feature="unknown" data-startupapi-feature-off>');
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    });

    it('writes an empty attribute when nothing differs', async () => {
      Feature.reset();
      Feature.init([
        { id: 'rolled_out', name: 'Rolled out', rolled_out_to_all_users: true },
        { id: 'beta', name: 'Beta' },
      ]);
      const api = createStartupAPI({ ...config, features: undefined, plans: undefined, featureDelivery: { html: true } });
      const { res } = await proxy(api, '/page', {}, html);
      expect(await res.text()).toContain('<html lang="en" data-startupapi-features="">');
    });

    it("adds the visitor's own features and shows their elements", async () => {
      const api = createStartupAPI({ ...config, featureDelivery: { html: true } });
      const userId = await newUserInAccount(await newAccount());
      await Feature.require('beta').enableForUser(env, userId);
      const { res } = await proxy(api, '/page', { Cookie: await sessionCookie(userId) }, html);
      const body = await res.text();
      expect(body).toContain('data-startupapi-features="-disabled -shutdown beta"');
      expect(body).toContain('<button data-startupapi-feature="beta">');
    });

    it('never touches a response that is not HTML', async () => {
      const api = createStartupAPI({ ...config, featureDelivery: { html: true } });
      const { res } = await proxy(
        api,
        '/data.json',
        {},
        () => new Response('{"a":1}', { headers: { 'Content-Type': 'application/json' } }),
      );
      expect(await res.text()).toBe('{"a":1}');
    });
  });

  it('sends no features header when no features are configured', async () => {
    Feature.reset();
    const api = createStartupAPI({ accessPolicy: { default: { mode: 'public' } } });
    const { originRequest } = await proxy(api, '/page', { 'X-StartupAPI-Features': 'beta' });
    expect(originRequest?.headers.has('X-StartupAPI-Features')).toBe(false);
  });

  it('gates a path on a feature', async () => {
    const api = createStartupAPI(config);
    const userId = await newUserInAccount(await newAccount());
    const cookie = await sessionCookie(userId);

    expect((await proxy(api, '/beta/page', { Cookie: cookie })).res.status).toBe(403);
    await Feature.require('beta').enableForUser(env, userId);
    expect((await proxy(api, '/beta/page', { Cookie: cookie })).res.status).toBe(200);
  });

  it('gates admins on a feature like everyone else', async () => {
    const api = createStartupAPI(config);
    // ADMIN_IDS=admin; in the test environment the admin's DO id is derived from that name.
    const adminId = env.USER.idFromName('admin').toString();
    await Feature.require('beta').removeForUser(env, adminId);
    const cookie = await sessionCookie(adminId);

    expect((await proxy(api, '/beta/page', { Cookie: cookie })).res.status).toBe(403);
    await Feature.require('beta').enableForUser(env, adminId);
    expect((await proxy(api, '/beta/page', { Cookie: cookie })).res.status).toBe(200);
    await Feature.require('beta').removeForUser(env, adminId);
  });

  it('rejects a plan that references an unknown feature', async () => {
    Feature.reset();
    Plan.clear();
    const api = createStartupAPI({ features: FEATURES, plans: [{ slug: 'free', name: 'Free', features: ['typo'] }] });
    const ctx = createExecutionContext();
    await expect(api.fetch(new Request('http://example.com/'), env, ctx)).rejects.toThrow(/Plan 'free' references unknown feature 'typo'/);
  });

  it('lists features in /api/me', async () => {
    const api = createStartupAPI(config);
    const userId = await newUserInAccount(await newAccount('pro'));
    const { res } = await proxy(api, '/users/api/me', { Cookie: await sessionCookie(userId) });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.features).toEqual(['rolled_out', 'pro_reports']);
  });

  describe('admin API', () => {
    async function adminCookie(): Promise<string> {
      // ADMIN_IDS=admin; in the test environment the admin's DO id is derived from that name.
      return sessionCookie(env.USER.idFromName('admin').toString());
    }

    async function admin(api: ReturnType<typeof createStartupAPI>, method: string, path: string) {
      const ctx = createExecutionContext();
      const res = await api.fetch(
        new Request(`http://example.com/users/admin/api/${path}`, { method, headers: { Cookie: await adminCookie() } }),
        env,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return res;
    }

    it('lists feature definitions with counts and totals', async () => {
      const api = createStartupAPI(config);
      const res = await admin(api, 'GET', 'features');
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.total_users).toEqual(expect.any(Number));
      expect(data.total_accounts).toEqual(expect.any(Number));
      expect(data.features.map((f: any) => f.id)).toEqual(FEATURES.map((f) => f.id));
      expect(data.features.find((f: any) => f.id === 'shutdown')).toMatchObject({ emergency_shutdown: true, state: 'off' });
      expect(data.features.find((f: any) => f.id === 'beta')).toMatchObject({
        name: 'Beta',
        enabled: true,
        rolled_out_to_all_users: false,
        state: 'contextual',
        user_count: expect.any(Number),
        account_count: expect.any(Number),
      });
    });

    it('shows plan-granted features and account overrides', async () => {
      const api = createStartupAPI(config);
      const accountId = await newAccount('pro');

      expect((await admin(api, 'PUT', `accounts/${accountId}/features/beta`)).status).toBe(200);
      const features = (await (await admin(api, 'GET', `accounts/${accountId}/features`)).json()) as any[];
      expect(features.find((f) => f.id === 'beta')).toMatchObject({ active: true, override: true, plan: null });
      expect(features.find((f) => f.id === 'pro_reports')).toMatchObject({
        active: true,
        override: false,
        plan: { slug: 'pro', name: 'Pro' },
      });
      expect(features.find((f) => f.id === 'rolled_out')).toMatchObject({ active: true, override: false, plan: null });

      expect((await admin(api, 'DELETE', `accounts/${accountId}/features/beta`)).status).toBe(200);
      const after = (await (await admin(api, 'GET', `accounts/${accountId}/features`)).json()) as any[];
      expect(after.find((f) => f.id === 'beta')).toMatchObject({ active: false, override: false });
    });

    it('lists every account of a user that has a feature, and user overrides', async () => {
      const api = createStartupAPI(config);
      const proAccount = await newAccount('pro');
      await env.ACCOUNT.get(env.ACCOUNT.idFromString(proAccount)).updateInfo({ name: 'Pro Co' });
      const freeAccount = await newAccount();
      // Current account is the free one; the feature still shows as enabled in the pro account.
      const userId = await newUserInAccount(proAccount);
      await env.USER.get(env.USER.idFromString(userId)).addMembership(freeAccount, 1, true);

      let features = (await (await admin(api, 'GET', `users/${userId}/features`)).json()) as any[];
      expect(features.find((f) => f.id === 'pro_reports')).toMatchObject({
        active: false,
        override: false,
        accounts: [{ id: proAccount, name: 'Pro Co' }],
      });
      expect(features.find((f) => f.id === 'rolled_out')).toMatchObject({ active: true, accounts: [] });

      expect((await admin(api, 'PUT', `users/${userId}/features/beta`)).status).toBe(200);
      features = (await (await admin(api, 'GET', `users/${userId}/features`)).json()) as any[];
      expect(features.find((f) => f.id === 'beta')).toMatchObject({ active: true, override: true, accounts: [] });
    });

    it('returns 404 for an unknown feature', async () => {
      const api = createStartupAPI(config);
      const accountId = await newAccount();
      expect((await admin(api, 'PUT', `accounts/${accountId}/features/nope`)).status).toBe(404);
    });
  });
});
