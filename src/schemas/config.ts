import { z } from 'zod';
import { AccessPolicySchema } from './policy';

/**
 * Zod schema + types for the StartupAPI configuration factory (see src/createStartupAPI.ts).
 *
 * Only non-secret behavior lives here — provider enablement, per-provider freshness toggles, access
 * policy and plans. Credentials/secrets stay in env. Every field is optional and falls back to
 * env-derived defaults, so `createStartupAPI()` with no config behaves like the previous package.
 */

const TtlFreshnessSchema = z.union([z.boolean(), z.object({ ms: z.number().positive().optional() })]);
const CronFreshnessSchema = z.union([z.boolean(), z.object({ schedule: z.string().optional() })]);

export const ProviderFreshnessSchema = z.object({
  /** Lazily re-check entitlements on the request hot path when older than the TTL. Off by default. */
  ttl: TtlFreshnessSchema.optional(),
  /** Periodically re-sync entitlements via a scheduled() handler. Off by default. */
  cron: CronFreshnessSchema.optional(),
  /** Update entitlements from provider webhooks (Patreon only). Off by default. */
  webhook: z.boolean().optional(),
});

export const ProviderOptionsSchema = z.object({
  /** Force-enable/disable the provider. Default: enabled iff its credentials are present in env. */
  enabled: z.boolean().optional(),
  /** Extra OAuth scopes to request, on top of the provider's required base scopes. */
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
  /** Patreon only: restrict entitlements to a single campaign id. */
  campaignId: z.string().optional(),
  /** Patreon only: user id(s) of the campaign owner(s), granted access without an entitlement check. */
  campaignOwnerId: z.union([z.string(), z.array(z.string())]).optional(),
  freshness: ProviderFreshnessSchema.optional(),
});

export const StartupAPIConfigSchema = z.object({
  providers: z.record(z.string(), ProviderOptionsSchema).optional(),
  accessPolicy: AccessPolicySchema.optional(),
  // Plans are validated by the billing layer; accept an array passthrough here.
  plans: z.array(z.any()).optional(),
});

export type ProviderFreshness = z.infer<typeof ProviderFreshnessSchema>;
export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;
export type StartupAPIConfig = z.input<typeof StartupAPIConfigSchema>;

/** Normalized per-provider freshness after resolving boolean/object forms and env fallbacks. */
export interface ResolvedFreshness {
  ttl: { enabled: boolean; ms: number };
  cron: { enabled: boolean; schedule: string };
  webhook: { enabled: boolean };
}
