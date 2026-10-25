import { z } from 'zod';

/**
 * Zod schemas for feature flags (see src/features/Feature.ts and specs/features.md).
 *
 * Features are defined in code (factory config). The global switches below can only change with a
 * deploy; per-account and per-user overrides are stored in the Durable Objects.
 */

/** Feature ids are stable string keys (like plan slugs), safe to use in headers and URL paths. */
export const FeatureIdSchema = z.string().regex(/^[a-z0-9_-]+$/, 'Feature id must contain only lowercase letters, digits, "_" and "-"');

export const FeatureConfigSchema = z.object({
  id: FeatureIdSchema,
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Optional longer explanation, shown under the name in the admin dashboard. */
  description: z.string().optional(),
  /** Global master switch: must be true for the feature to work anywhere. */
  enabled: z.boolean().default(true),
  /** Enables the feature for everyone, without reading any account or user data. */
  rolled_out_to_all_users: z.boolean().default(false),
  /** Kill switch: disables the feature everywhere, overriding every other setting. */
  emergency_shutdown: z.boolean().default(false),
});

export const FeaturesConfigSchema = z.array(FeatureConfigSchema).superRefine((features, ctx) => {
  const seen = new Set<string>();
  features.forEach((feature, index) => {
    if (seen.has(feature.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: `Duplicate feature id '${feature.id}'` });
    }
    seen.add(feature.id);
  });
});

export type FeatureConfig = z.input<typeof FeatureConfigSchema>;
export type FeatureConfigResolved = z.output<typeof FeatureConfigSchema>;

/** Where a feature's enabled state for an account or user came from (admin API). */
export type FeatureSource = 'static' | 'plan' | 'override' | 'account' | null;

/**
 * How the resolved features reach the origin (README "Feature flags").
 *
 * `header`: what `X-StartupAPI-Features` carries.
 *  - `'delta'` (default): only what differs from each feature's baseline (`rolled_out_to_all_users`):
 *    `id` for a feature that is on although not rolled out, `-id` for a rolled-out feature that is off.
 *    The origin knows the baselines (it ships the same definitions), so features rolled out to
 *    everyone, or off for everyone, cost nothing per request.
 *  - `'enabled'`: every enabled id, for origins that don't know the baselines.
 *  - `'none'`: no header.
 *
 * `html`: when true, HTML pages from the origin get the delta as `<html data-startupapi-features>`
 * (space-separated) and elements tagged `data-startupapi-feature="<id>"` get `data-startupapi-feature-off`
 * set when the feature is off and removed when it's on.
 */
export const FeatureDeliverySchema = z.object({
  header: z.enum(['delta', 'enabled', 'none']).default('delta'),
  html: z.boolean().default(false),
});

export type FeatureDelivery = z.input<typeof FeatureDeliverySchema>;
export type FeatureDeliveryResolved = z.output<typeof FeatureDeliverySchema>;
