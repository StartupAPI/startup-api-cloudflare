import type { Entitlements } from '../entitlements/types';
import type { EntitlementCondition } from '../schemas/policy';

/**
 * Provider entitlement checker registry — the ONLY place provider-specific access logic lives.
 *
 * Each entry maps a provider name to a function that decides whether a given entitlement condition is
 * satisfied by the user's resolved entitlements. The access policy engine dispatches through this map,
 * so adding perk-level checks for a new provider is purely additive (register a checker + implement
 * the provider's `fetchEntitlements`) with no engine changes.
 *
 * Only Patreon participates today; Google/Twitch register nothing and therefore cannot be the target
 * of an entitlement requirement (the policy rejects that at init time).
 */
export type EntitlementChecker = (condition: EntitlementCondition, entitlements: Entitlements | null) => boolean;

export const providerEntitlementCheckers: Record<string, EntitlementChecker> = {
  patreon(condition, entitlements) {
    const patreon = entitlements?.patreon;
    if (!patreon) return false;
    // The campaign owner has no membership to their own campaign — grant access regardless of condition.
    if (patreon.is_campaign_owner) return true;
    switch (condition.type) {
      case 'active_patron':
        return patreon.is_active_patron;
      case 'benefit':
        return patreon.entitled_benefit_ids.includes(condition.benefit_id);
      case 'tier':
        return patreon.entitled_tier_ids.includes(condition.tier_id);
      default:
        return false;
    }
  },
};

export function providerSupportsEntitlements(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(providerEntitlementCheckers, provider);
}
