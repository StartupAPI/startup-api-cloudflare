import { z } from 'zod';

/**
 * Zod schemas for the path-based access policy (see src/policy/accessPolicy.ts).
 *
 * A policy is an ordered list of rules mapping a URL path pattern to an access requirement, plus a
 * default requirement for unmatched paths. The requirement modes are provider-agnostic except for
 * `entitlement`, whose `condition` is provider-scoped and validated against the provider entitlement
 * checker registry at policy-init time.
 */

/**
 * Provider entitlement conditions. Currently only Patreon implements these; the engine rejects an
 * entitlement requirement whose provider has no registered checker.
 */
export const EntitlementConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('active_patron') }),
  z.object({ type: z.literal('benefit'), benefit_id: z.string() }),
  z.object({ type: z.literal('tier'), tier_id: z.string() }),
]);

export const RequirementSchema = z.discriminatedUnion('mode', [
  // Raw pass-through: no credential check, no identity resolution, no headers, no injection.
  z.object({ mode: z.literal('bypass') }),
  // Anyone; resolve session if present and forward identity/entitlement headers.
  z.object({ mode: z.literal('public') }),
  // Any logged-in user.
  z.object({ mode: z.literal('authenticated') }),
  // Provider-specific entitlement (e.g. Patreon active patron / benefit / tier).
  z.object({
    mode: z.literal('entitlement'),
    provider: z.string(),
    condition: EntitlementConditionSchema,
  }),
]);

export const UnauthorizedActionSchema = z.enum(['login', 'forbidden', 'upgrade']);

export const RuleSchema = z.object({
  /** Path pattern: exact (`/special`), prefix (`/special/*`), or `/` for the homepage only. */
  pattern: z.string(),
  requirement: RequirementSchema,
  /** What to do when the requirement is not met. Defaults to 'login'. */
  on_unauthorized: UnauthorizedActionSchema.default('login'),
  /** Redirect target for the 'upgrade' action (e.g. a Patreon join page). */
  upgrade_url: z.string().optional(),
});

export const AccessPolicySchema = z.object({
  rules: z.array(RuleSchema).default([]),
  /** Requirement applied to paths that match no rule. Defaults to 'authenticated' when omitted. */
  default: RequirementSchema.optional(),
  default_on_unauthorized: UnauthorizedActionSchema.default('login'),
  default_upgrade_url: z.string().optional(),
});

export type EntitlementCondition = z.infer<typeof EntitlementConditionSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type UnauthorizedAction = z.infer<typeof UnauthorizedActionSchema>;
export type AccessRule = z.infer<typeof RuleSchema>;
export type AccessPolicyConfig = z.input<typeof AccessPolicySchema>;
export type AccessPolicyResolved = z.output<typeof AccessPolicySchema>;
