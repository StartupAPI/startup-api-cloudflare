import type { PatreonEntitlement } from './types';

/**
 * Parse a Patreon v2 `identity` response (JSON:API) into our flat {@link PatreonEntitlement}.
 *
 * The relevant request is:
 *   GET /api/oauth2/v2/identity
 *     ?include=memberships,memberships.currently_entitled_tiers,memberships.currently_entitled_tiers.benefits
 *     &fields[member]=patron_status,currently_entitled_amount_cents
 *     &fields[tier]=title&fields[benefit]=title
 *
 * The response carries the user in `data`, with `data.relationships.memberships.data` listing member
 * refs, and the full member/tier/benefit objects in the top-level `included` array. We resolve refs
 * through `included`, walking member → currently_entitled_tiers → benefits.
 *
 * When `campaignId` is provided, only the membership for that campaign is considered (a user may be a
 * patron of several campaigns through the same Patreon account); otherwise all memberships aggregate.
 *
 * `ownerIds` lists Patreon user ids that own the campaign being gated on. The campaign owner has no
 * membership to their own campaign, so they are flagged `is_campaign_owner` (and later granted access
 * regardless of the entitlement condition). Ownership is also auto-detected when the identity response
 * exposes the user's owned-campaign relationship (requires the `campaigns` scope).
 */
export function parsePatreonIdentity(json: any, campaignId?: string, ownerIds: string[] = []): PatreonEntitlement {
  const empty: PatreonEntitlement = {
    patron_status: null,
    is_active_patron: false,
    is_campaign_owner: false,
    entitled_tier_ids: [],
    entitled_benefit_ids: [],
    pledge_amount_cents: null,
  };

  if (!json || typeof json !== 'object' || !json.data) return empty;

  // Campaign-owner detection: explicit owner id list, or the user's own campaign relationship
  // (present only when the token has the `campaigns` scope) matching the gated campaign.
  const userId = json.data.id != null ? String(json.data.id) : undefined;
  const ownedCampaignId = json.data.relationships?.campaign?.data?.id;
  const isCampaignOwner =
    (userId != null && ownerIds.map(String).includes(userId)) ||
    (ownedCampaignId != null && (!campaignId || String(ownedCampaignId) === String(campaignId)));

  // Index every included resource by `${type}:${id}` for O(1) ref resolution.
  const included = new Map<string, any>();
  for (const item of Array.isArray(json.included) ? json.included : []) {
    if (item && item.type && item.id != null) {
      included.set(`${item.type}:${item.id}`, item);
    }
  }
  const resolve = (ref: any) => (ref && ref.type && ref.id != null ? included.get(`${ref.type}:${ref.id}`) : undefined);

  const membershipRefs: any[] = json.data?.relationships?.memberships?.data ?? [];

  const tierIds = new Set<string>();
  const benefitIds = new Set<string>();
  let patronStatus: PatreonEntitlement['patron_status'] = null;
  let pledgeAmount: number | null = null;

  for (const memberRef of membershipRefs) {
    const member = resolve(memberRef);
    if (!member) continue;

    // Filter to a specific campaign when configured.
    if (campaignId) {
      const memberCampaignId = member.relationships?.campaign?.data?.id;
      if (memberCampaignId && String(memberCampaignId) !== String(campaignId)) continue;
    }

    const status = member.attributes?.patron_status ?? null;
    // Prefer an active membership's status/amount; otherwise keep the first non-null seen.
    if (status === 'active_patron' || patronStatus === null) {
      patronStatus = status;
    }
    const amount = member.attributes?.currently_entitled_amount_cents;
    if (typeof amount === 'number' && (pledgeAmount === null || status === 'active_patron')) {
      pledgeAmount = amount;
    }

    const tierRefs: any[] = member.relationships?.currently_entitled_tiers?.data ?? [];
    for (const tierRef of tierRefs) {
      if (tierRef?.id == null) continue;
      tierIds.add(String(tierRef.id));
      const tier = resolve(tierRef);
      const benefitRefs: any[] = tier?.relationships?.benefits?.data ?? [];
      for (const benefitRef of benefitRefs) {
        if (benefitRef?.id != null) benefitIds.add(String(benefitRef.id));
      }
    }
  }

  return {
    patron_status: patronStatus,
    is_active_patron: patronStatus === 'active_patron',
    is_campaign_owner: isCampaignOwner,
    entitled_tier_ids: [...tierIds],
    entitled_benefit_ids: [...benefitIds],
    pledge_amount_cents: pledgeAmount,
  };
}
