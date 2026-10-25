import { Plan } from '../billing/Plan';
import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { FeatureSource } from '../schemas/feature';
import type { Feature } from './Feature';

/**
 * Feature resolution hierarchy (specs/features.md):
 *
 *   1. Emergency shutdown or global `enabled: false` → disabled
 *   2. `rolled_out_to_all_users` → enabled
 *   3. Context: accounts get it from their plan or an account override; users get it from an override
 *      or inherit it from their current account.
 *
 * Steps 1–2 come from code config, so they resolve with no I/O. Durable Objects are only read when at
 * least one "contextual" feature (enabled, not rolled out) is being resolved. All resolution runs in
 * the worker; the DOs only store the override sets.
 */

export interface FeatureResolution {
  id: string;
  enabled: boolean;
  source: FeatureSource;
}

/** Resolve steps 1–2 for every feature and split out the ones that need context data. */
function resolveStatic(features: Feature[]): { resolved: FeatureResolution[]; contextual: Feature[] } {
  const resolved: FeatureResolution[] = [];
  const contextual: Feature[] = [];
  for (const feature of features) {
    const state = feature.staticState();
    if (state === 'contextual') contextual.push(feature);
    else resolved.push({ id: feature.id, enabled: state === 'on', source: 'static' });
  }
  return { resolved, contextual };
}

/** Return resolutions in feature config order, so headers and API output are stable. */
function inConfigOrder(features: Feature[], resolutions: FeatureResolution[]): FeatureResolution[] {
  const byId = new Map(resolutions.map((r) => [r.id, r]));
  return features.map((f) => byId.get(f.id)!);
}

/** Resolve steps 1–2 only (no I/O): contextual features are off. Used for anonymous visitors. */
export function resolveAnonymousFeatures(features: Feature[]): FeatureResolution[] {
  return features.map((f) => {
    const state = f.staticState();
    return { id: f.id, enabled: state === 'on', source: state === 'contextual' ? null : 'static' };
  });
}

/** Ids of features that are on for everyone (no I/O). Used for anonymous visitors. */
export function staticallyEnabledFeatureIds(features: Feature[]): string[] {
  return features.filter((f) => f.staticState() === 'on').map((f) => f.id);
}

/** Resolve contextual features for an account: the plan grants it, or an account override exists. */
async function resolveAccountContextual(env: StartupAPIEnv, accountId: string, contextual: Feature[]): Promise<FeatureResolution[]> {
  if (contextual.length === 0) return [];
  const accountStub = env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId));
  const { plan: planSlug, features: overrides } = await accountStub.getFeatureContext();
  const plan = planSlug ? Plan.get(planSlug) : undefined;
  return contextual.map((feature) => {
    if (plan?.hasFeatureEnabled(feature.id)) return { id: feature.id, enabled: true, source: 'plan' };
    if (overrides.includes(feature.id)) return { id: feature.id, enabled: true, source: 'override' };
    return { id: feature.id, enabled: false, source: null };
  });
}

export async function resolveAccountFeatures(env: StartupAPIEnv, accountId: string, features: Feature[]): Promise<FeatureResolution[]> {
  const { resolved, contextual } = resolveStatic(features);
  return inConfigOrder(features, [...resolved, ...(await resolveAccountContextual(env, accountId, contextual))]);
}

/**
 * Resolve features for a user: a user override, else inherited from the user's current account.
 * Pass `currentAccountId` when the caller already knows it (null = no account) to skip that lookup.
 */
export async function resolveUserFeatures(
  env: StartupAPIEnv,
  userId: string,
  features: Feature[],
  currentAccountId?: string | null,
): Promise<FeatureResolution[]> {
  const { resolved, contextual } = resolveStatic(features);
  if (contextual.length === 0) return inConfigOrder(features, resolved);

  const userStub = env.USER.get(env.USER.idFromString(userId));
  const overrides = await userStub.getFeatureOverrides();
  const remaining: Feature[] = [];
  for (const feature of contextual) {
    if (overrides.includes(feature.id)) resolved.push({ id: feature.id, enabled: true, source: 'override' });
    else remaining.push(feature);
  }
  if (remaining.length === 0) return inConfigOrder(features, resolved);

  let accountId = currentAccountId;
  if (accountId === undefined) {
    accountId = (await userStub.getCurrentAccount())?.account_id ?? null;
  }
  if (!accountId) {
    return inConfigOrder(features, [...resolved, ...remaining.map((f) => ({ id: f.id, enabled: false, source: null }))]);
  }

  const fromAccount = await resolveAccountContextual(env, accountId, remaining);
  return inConfigOrder(features, [...resolved, ...fromAccount.map((r) => (r.enabled ? { ...r, source: 'account' as const } : r))]);
}

export function enabledIds(resolutions: FeatureResolution[]): string[] {
  return resolutions.filter((r) => r.enabled).map((r) => r.id);
}

/**
 * What differs from each feature's baseline, its release state `rolled_out_to_all_users`: `id` for a
 * feature that is on although not rolled out (an override or the plan), `-id` for a rolled-out
 * feature that is off (emergency shutdown or `enabled: false`). In config order.
 *
 * A client that knows the baselines rebuilds the full state from this, and it stays short however
 * many features are defined: most visitors get nothing, or a few beta features.
 */
export function deltaTokens(features: Feature[], resolutions: FeatureResolution[]): string[] {
  const enabled = new Map(resolutions.map((r) => [r.id, r.enabled]));
  const tokens: string[] = [];
  for (const feature of features) {
    const on = enabled.get(feature.id) ?? false;
    if (on && !feature.rolled_out_to_all_users) tokens.push(feature.id);
    else if (!on && feature.rolled_out_to_all_users) tokens.push(`-${feature.id}`);
  }
  return tokens;
}
