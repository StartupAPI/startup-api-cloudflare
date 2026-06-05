import { describe, it, expect } from 'vitest';
import { parsePatreonIdentity } from '../src/entitlements/patreon';

function identity(memberStatus: string | null, tiers: Array<{ id: string; benefits: string[] }>, opts: { amount?: number; campaign?: string } = {}) {
  const included: any[] = [];
  if (memberStatus !== null || tiers.length) {
    included.push({
      type: 'member',
      id: 'm1',
      attributes: { patron_status: memberStatus, currently_entitled_amount_cents: opts.amount ?? null },
      relationships: {
        currently_entitled_tiers: { data: tiers.map((t) => ({ type: 'tier', id: t.id })) },
        campaign: { data: { type: 'campaign', id: opts.campaign ?? 'camp-1' } },
      },
    });
    for (const t of tiers) {
      included.push({
        type: 'tier',
        id: t.id,
        attributes: { title: t.id },
        relationships: { benefits: { data: t.benefits.map((b) => ({ type: 'benefit', id: b })) } },
      });
    }
  }
  return {
    data: { type: 'user', id: 'user-1', relationships: { memberships: { data: included.length ? [{ type: 'member', id: 'm1' }] : [] } } },
    included,
  };
}

describe('parsePatreonIdentity', () => {
  it('parses an active patron with multiple tiers and dedupes benefits', () => {
    const json = identity('active_patron', [
      { id: 't1', benefits: ['benefit-vip', 'b-shared'] },
      { id: 't2', benefits: ['b-shared'] },
    ], { amount: 500 });

    const result = parsePatreonIdentity(json);
    expect(result.patron_status).toBe('active_patron');
    expect(result.is_active_patron).toBe(true);
    expect(result.entitled_tier_ids.sort()).toEqual(['t1', 't2']);
    expect(result.entitled_benefit_ids.sort()).toEqual(['b-shared', 'benefit-vip']);
    expect(result.pledge_amount_cents).toBe(500);
  });

  it('returns an empty entitlement when there are no memberships', () => {
    const result = parsePatreonIdentity(identity(null, []));
    expect(result).toEqual({
      patron_status: null,
      is_active_patron: false,
      entitled_tier_ids: [],
      entitled_benefit_ids: [],
      pledge_amount_cents: null,
    });
  });

  it('marks a declined patron as not active', () => {
    const result = parsePatreonIdentity(identity('declined_patron', [{ id: 't1', benefits: ['b1'] }]));
    expect(result.patron_status).toBe('declined_patron');
    expect(result.is_active_patron).toBe(false);
    expect(result.entitled_benefit_ids).toEqual(['b1']);
  });

  it('filters memberships by campaign id when provided', () => {
    const json = identity('active_patron', [{ id: 't1', benefits: ['b1'] }], { campaign: 'other-campaign' });
    // Looking for our campaign 'camp-1' → the membership for 'other-campaign' is ignored.
    const result = parsePatreonIdentity(json, 'camp-1');
    expect(result.is_active_patron).toBe(false);
    expect(result.entitled_benefit_ids).toEqual([]);
  });

  it('handles malformed input gracefully', () => {
    expect(parsePatreonIdentity(null).is_active_patron).toBe(false);
    expect(parsePatreonIdentity({}).is_active_patron).toBe(false);
  });
});
