import { createStartupAPI } from './createStartupAPI';

/**
 * Default StartupAPI instance, built from environment configuration only (no code config). This keeps
 * the long-standing usage working unchanged:
 *
 *   export { default, UserDO, AccountDO, SystemDO, CredentialDO } from '@startup-api/cloudflare';
 *
 * To customize behavior (provider freshness, access policy, plans), import `createStartupAPI` and pass
 * a config object instead of re-exporting the default.
 */
const instance = createStartupAPI();

export const UserDO = instance.UserDO;
export const AccountDO = instance.AccountDO;
export const SystemDO = instance.SystemDO;
export const CredentialDO = instance.CredentialDO;

export { createStartupAPI };
export { Feature, hasFeature } from './features/Feature';
export type { StartupAPIConfig } from './schemas/config';
export type { FeatureConfig, FeatureDelivery } from './schemas/feature';

export default instance.default;
