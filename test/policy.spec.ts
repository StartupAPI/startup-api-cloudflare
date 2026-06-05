import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { AccessPolicy, evaluateAccess, matchPattern } from '../src/policy/accessPolicy';
import type { AccessRule } from '../src/schemas/policy';
import type { Entitlements } from '../src/entitlements/types';

const patreonEntitlements = (benefits: string[], active = true): Entitlements => ({
  provider: 'patreon',
  checked_at: 0,
  source: 'oauth',
  patreon: {
    patron_status: active ? 'active_patron' : 'former_patron',
    is_active_patron: active,
    entitled_tier_ids: ['t1'],
    entitled_benefit_ids: benefits,
    pledge_amount_cents: 500,
  },
});

const rule = (requirement: any, on_unauthorized: any = 'login'): AccessRule => ({ pattern: '/x', requirement, on_unauthorized });

describe('matchPattern', () => {
  it('matches the homepage only for "/"', () => {
    expect(matchPattern('/', '/')).toBe(true);
    expect(matchPattern('/', '/foo')).toBe(false);
  });
  it('matches exact paths', () => {
    expect(matchPattern('/special', '/special')).toBe(true);
    expect(matchPattern('/special', '/special/x')).toBe(false);
  });
  it('matches prefix patterns ending in /*', () => {
    expect(matchPattern('/app/*', '/app')).toBe(true);
    expect(matchPattern('/app/*', '/app/page')).toBe(true);
    expect(matchPattern('/app/*', '/application')).toBe(false);
  });
});

describe('evaluateAccess', () => {
  it('allows bypass and public regardless of auth', () => {
    expect(evaluateAccess(rule({ mode: 'bypass' }), { authenticated: false, entitlements: null }).allow).toBe(true);
    expect(evaluateAccess(rule({ mode: 'public' }), { authenticated: false, entitlements: null }).allow).toBe(true);
  });

  it('requires a logged-in user for authenticated', () => {
    expect(evaluateAccess(rule({ mode: 'authenticated' }), { authenticated: true, entitlements: null }).allow).toBe(true);
    const denied = evaluateAccess(rule({ mode: 'authenticated' }, 'login'), { authenticated: false, entitlements: null });
    expect(denied).toEqual({ allow: false, reason: 'unauthenticated', action: 'login', upgrade_url: undefined });
  });

  it('checks Patreon active_patron condition', () => {
    const r = rule({ mode: 'entitlement', provider: 'patreon', condition: { type: 'active_patron' } }, 'forbidden');
    expect(evaluateAccess(r, { authenticated: true, entitlements: patreonEntitlements([], true) }).allow).toBe(true);
    expect(evaluateAccess(r, { authenticated: true, entitlements: patreonEntitlements([], false) }).allow).toBe(false);
  });

  it('checks Patreon benefit condition', () => {
    const r = rule({ mode: 'entitlement', provider: 'patreon', condition: { type: 'benefit', benefit_id: 'vip' } }, 'upgrade');
    expect(evaluateAccess(r, { authenticated: true, entitlements: patreonEntitlements(['vip']) }).allow).toBe(true);
    const denied = evaluateAccess(r, { authenticated: true, entitlements: patreonEntitlements(['other']) });
    expect(denied).toMatchObject({ allow: false, reason: 'not_entitled', action: 'upgrade' });
  });

  it('denies an entitlement requirement when not authenticated', () => {
    const r = rule({ mode: 'entitlement', provider: 'patreon', condition: { type: 'active_patron' } });
    expect(evaluateAccess(r, { authenticated: false, entitlements: null })).toMatchObject({ reason: 'unauthenticated' });
  });
});

describe('AccessPolicy', () => {
  beforeEach(() => AccessPolicy.reset());
  // Leave the singleton uninitialized so the worker re-inits from env in other test files.
  afterAll(() => AccessPolicy.reset());

  it('resolves first-matching rule then default', () => {
    AccessPolicy.init({
      rules: [{ pattern: '/special', requirement: { mode: 'entitlement', provider: 'patreon', condition: { type: 'active_patron' } } }],
      default: { mode: 'public' },
    });
    expect(AccessPolicy.evaluate('/special').requirement.mode).toBe('entitlement');
    expect(AccessPolicy.evaluate('/anything').requirement.mode).toBe('public');
  });

  it('defaults unmatched paths to authenticated when no default is configured', () => {
    AccessPolicy.init({ rules: [] });
    expect(AccessPolicy.evaluate('/x').requirement.mode).toBe('authenticated');
  });

  it('rejects an entitlement condition for a provider that does not support entitlements', () => {
    expect(() =>
      AccessPolicy.init({
        rules: [{ pattern: '/x', requirement: { mode: 'entitlement', provider: 'twitch', condition: { type: 'active_patron' } } }],
      }),
    ).toThrow(/twitch/);
  });
});
