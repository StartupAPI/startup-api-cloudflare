import { z } from 'zod';
import { AccessPolicySchema } from './policy';

/**
 * Zod schema + types for the StartupAPI configuration factory (see src/createStartupAPI.ts).
 *
 * Only non-secret behavior lives here — provider enablement, entitlement freshness, session lifetime,
 * access policy and plans. Credentials/secrets stay in env. Every field is optional and falls back to
 * env-derived defaults, so `createStartupAPI()` with no config behaves like the previous package.
 */

/** Default login session lifetime (rolling window) when no `session.ttl` is configured. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * A human-friendly duration. Either a named-unit object (`{ days: 30 }`, `{ minutes: 15 }`, units are
 * summed) or a plain number of milliseconds (`86400000`). Use `durationToMs()` to normalize.
 */
export const DurationSchema = z.union([
  z.number().nonnegative(),
  z
    .object({
      days: z.number().nonnegative().optional(),
      hours: z.number().nonnegative().optional(),
      minutes: z.number().nonnegative().optional(),
      seconds: z.number().nonnegative().optional(),
      ms: z.number().nonnegative().optional(),
    })
    .strict(),
]);
export type Duration = z.infer<typeof DurationSchema>;

/** Normalize a Duration to milliseconds. A bare number is treated as ms; object units are summed. */
export function durationToMs(d: Duration): number {
  if (typeof d === 'number') return d;
  return (d.days ?? 0) * 86400000 + (d.hours ?? 0) * 3600000 + (d.minutes ?? 0) * 60000 + (d.seconds ?? 0) * 1000 + (d.ms ?? 0);
}

/** Periodic re-sync of entitlements via a scheduled() handler. `true`/`{ schedule }` on, off by default. */
const EntitlementCronSchema = z.union([z.boolean(), z.object({ schedule: z.string().optional() })]);

export const ProviderOptionsSchema = z.object({
  /** Force-enable/disable the provider. Default: enabled iff its credentials are present in env. */
  enabled: z.boolean().optional(),
  /** Extra OAuth scopes to request, on top of the provider's required base scopes. */
  scopes: z.union([z.string(), z.array(z.string())]).optional(),
  /** Patreon only: restrict entitlements to a single campaign id. */
  campaignId: z.string().optional(),
  /** atproto only: display name advertised in the client-metadata document. Default: "StartupAPI". */
  clientName: z.string().optional(),
  /** atproto only: override the PLC directory used to resolve did:plc identities. Default: https://plc.directory. */
  plcUrl: z.string().optional(),
  /** atproto only: override the DNS-over-HTTPS resolver used for handle resolution. */
  dohUrl: z.string().optional(),
  /**
   * Lazily re-check entitlements on the request hot path when the cache is older than this duration.
   * ON by default for entitlement providers — default 1 day for Patreon, 15 min otherwise. Pass a
   * Duration to tune the interval, or `false` to disable (e.g. rely on the webhook only).
   */
  entitlementTtl: z.union([DurationSchema, z.literal(false)]).optional(),
  /** Update entitlements from provider webhooks (Patreon only). Off by default. */
  entitlementWebhook: z.boolean().optional(),
  /** Periodically re-sync all of this provider's entitlements via a scheduled() handler. Off by default. */
  entitlementCron: EntitlementCronSchema.optional(),
});

export const SessionConfigSchema = z.object({
  /**
   * Login session lifetime as a Duration (default 30 days). The session is a rolling window — renewed
   * on activity once less than half remains. Independent of entitlement freshness.
   */
  ttl: DurationSchema.optional(),
});

export const StartupAPIConfigSchema = z.object({
  providers: z.record(z.string(), ProviderOptionsSchema).optional(),
  accessPolicy: AccessPolicySchema.optional(),
  session: SessionConfigSchema.optional(),
  // Plans are validated by the billing layer; accept an array passthrough here.
  plans: z.array(z.any()).optional(),
});

export type ProviderOptions = z.infer<typeof ProviderOptionsSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type StartupAPIConfig = z.input<typeof StartupAPIConfigSchema>;

/** Normalized per-provider entitlement freshness after resolving the config forms and defaults. */
export interface ResolvedFreshness {
  ttl: { enabled: boolean; ms: number };
  cron: { enabled: boolean; schedule: string };
  webhook: { enabled: boolean };
}
