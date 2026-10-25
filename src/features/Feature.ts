import { FeaturesConfigSchema } from '../schemas/feature';
import type { FeatureConfig, FeatureConfigResolved } from '../schemas/feature';
import type { StartupAPIEnv } from '../StartupAPIEnv';
import { resolveAccountFeatures, resolveUserFeatures } from './resolve';

/** Result of the code-config part of the resolution hierarchy (steps 1–2 in specs/features.md). */
export type FeatureStaticState = 'off' | 'on' | 'contextual';

/**
 * A distinct piece of functionality that can be toggled (specs/features.md). Features are defined in
 * the factory config (`createStartupAPI({ features: [...] })`) and kept in a static registry that
 * mirrors the Plan registry.
 */
export class Feature {
  id: string;
  name: string;
  enabled: boolean;
  rolled_out_to_all_users: boolean;
  emergency_shutdown: boolean;

  constructor(config: FeatureConfigResolved) {
    this.id = config.id;
    this.name = config.name;
    this.enabled = config.enabled;
    this.rolled_out_to_all_users = config.rolled_out_to_all_users;
    this.emergency_shutdown = config.emergency_shutdown;
  }

  /**
   * Resolve the global switches: emergency shutdown or `enabled: false` → off, rolled out → on.
   * Anything else depends on the account or user ('contextual').
   */
  staticState(): FeatureStaticState {
    if (this.emergency_shutdown || !this.enabled) return 'off';
    if (this.rolled_out_to_all_users) return 'on';
    return 'contextual';
  }

  async isEnabledForAccount(env: StartupAPIEnv, accountId: string): Promise<boolean> {
    const [resolution] = await resolveAccountFeatures(env, accountId, [this]);
    return resolution.enabled;
  }

  async isEnabledForUser(env: StartupAPIEnv, userId: string): Promise<boolean> {
    const [resolution] = await resolveUserFeatures(env, userId, [this]);
    return resolution.enabled;
  }

  /** Enable this feature for an account, regardless of its plan. */
  async enableForAccount(env: StartupAPIEnv, accountId: string): Promise<void> {
    await env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId)).setFeatureOverride(this.id, true);
  }

  /** Remove the account override (the plan may still grant the feature). */
  async removeForAccount(env: StartupAPIEnv, accountId: string): Promise<void> {
    await env.ACCOUNT.get(env.ACCOUNT.idFromString(accountId)).setFeatureOverride(this.id, false);
  }

  /** Enable this feature for a user, regardless of their current account. */
  async enableForUser(env: StartupAPIEnv, userId: string): Promise<void> {
    await env.USER.get(env.USER.idFromString(userId)).setFeatureOverride(this.id, true);
  }

  /** Remove the user override (the user may still inherit the feature from their account). */
  async removeForUser(env: StartupAPIEnv, userId: string): Promise<void> {
    await env.USER.get(env.USER.idFromString(userId)).setFeatureOverride(this.id, false);
  }

  /** Number of users with an override for this feature. */
  async getUserCount(env: StartupAPIEnv): Promise<number> {
    const counts = await env.SYSTEM.get(env.SYSTEM.idFromName('global')).getFeatureCounts();
    return counts[this.id]?.users ?? 0;
  }

  /** Number of accounts with an override for this feature (accounts granted it by a plan are not counted). */
  async getAccountCount(env: StartupAPIEnv): Promise<number> {
    const counts = await env.SYSTEM.get(env.SYSTEM.idFromName('global')).getFeatureCounts();
    return counts[this.id]?.accounts ?? 0;
  }

  // Registry of features
  private static features: Map<string, Feature> | null = null;

  static init(features: FeatureConfig[]) {
    const parsed = FeaturesConfigSchema.parse(features);
    Feature.features = new Map(parsed.map((f) => [f.id, new Feature(f)]));
  }

  static isInitialized(): boolean {
    return Feature.features !== null;
  }

  /** Reset state — intended for tests that re-init with different configs. */
  static reset() {
    Feature.features = null;
  }

  static get(id: string): Feature | undefined {
    return Feature.features?.get(id);
  }

  /** Like get(), but throws for an unknown id. */
  static require(id: string): Feature {
    const feature = Feature.get(id);
    if (!feature) throw new Error(`Unknown feature '${id}'`);
    return feature;
  }

  static getAll(): Feature[] {
    return Array.from(Feature.features?.values() ?? []);
  }
}

/** Check whether a feature is enabled for a user (spec: `$user->hasFeature(...)`). */
export async function hasFeature(env: StartupAPIEnv, userId: string, featureId: string): Promise<boolean> {
  return Feature.require(featureId).isEnabledForUser(env, userId);
}
