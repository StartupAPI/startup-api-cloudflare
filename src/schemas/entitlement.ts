import { z } from 'zod';

/**
 * Zod schemas for the provider-agnostic entitlement model (see src/entitlements/types.ts).
 * Used to validate entitlement blobs on read/write from storage.
 */

export const PatreonEntitlementSchema = z.object({
  patron_status: z.enum(['active_patron', 'declined_patron', 'former_patron']).nullable(),
  is_active_patron: z.boolean(),
  is_campaign_owner: z.boolean(),
  entitled_tier_ids: z.array(z.string()),
  entitled_benefit_ids: z.array(z.string()),
  pledge_amount_cents: z.number().nullable(),
});

export const EntitlementsSchema = z.object({
  provider: z.string(),
  checked_at: z.number(),
  source: z.enum(['oauth', 'webhook', 'cron']),
  patreon: PatreonEntitlementSchema.optional(),
});

export type EntitlementsInput = z.input<typeof EntitlementsSchema>;
export type EntitlementsOutput = z.output<typeof EntitlementsSchema>;
