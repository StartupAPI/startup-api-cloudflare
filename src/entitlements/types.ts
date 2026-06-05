/**
 * Provider-agnostic entitlement model.
 *
 * Entitlements describe what a logged-in user is currently entitled to with a given OAuth provider —
 * for example, an active Patreon membership and the perks (benefits) it grants. The shape is generic;
 * each provider that supports entitlements populates its own sub-object. Only Patreon does today.
 */

export type EntitlementSource = 'oauth' | 'webhook' | 'cron';

export interface Entitlements {
  /** The provider these entitlements were resolved from (e.g. 'patreon'). */
  provider: string;
  /** When these entitlements were last successfully refreshed (epoch ms) — the TTL anchor. */
  checked_at: number;
  /** How the latest refresh was triggered. */
  source: EntitlementSource;
  /** Patreon-specific entitlement details (present only for the Patreon provider). */
  patreon?: PatreonEntitlement;
}

export interface PatreonEntitlement {
  patron_status: 'active_patron' | 'declined_patron' | 'former_patron' | null;
  /** Convenience flag derived from patron_status === 'active_patron'. */
  is_active_patron: boolean;
  /**
   * Whether this user is the owner (creator) of the campaign being gated on. Campaign owners have no
   * membership to their own campaign, so they would fail patron/benefit/tier checks; the entitlement
   * checker grants them access regardless of the configured condition.
   */
  is_campaign_owner: boolean;
  /** IDs of tiers the user is currently entitled to. */
  entitled_tier_ids: string[];
  /** IDs of benefits (perks) granted by the currently-entitled tiers (deduped). */
  entitled_benefit_ids: string[];
  /** Currently-entitled amount in cents, if known. */
  pledge_amount_cents: number | null;
}
