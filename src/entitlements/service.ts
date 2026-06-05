import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { OAuthProvider } from '../auth/OAuthProvider';
import type { Entitlements, EntitlementSource } from './types';
import { getValidAccessToken } from './tokenManager';
import type { StoredCredential } from './tokenManager';

/**
 * Fetch fresh entitlements for a credential and persist them to both the source of truth
 * (CredentialDO) and the hot-path cache (UserDO). Returns null when the provider has no entitlements,
 * the token can't be refreshed, or the provider call fails. Shared by login, lazy TTL, cron, webhook.
 */
export async function refreshEntitlements(
  env: StartupAPIEnv,
  provider: OAuthProvider,
  credential: StoredCredential,
  source: EntitlementSource,
): Promise<Entitlements | null> {
  if (!provider.supportsEntitlements()) return null;

  const token = await getValidAccessToken(env, provider, credential);
  if (!token) return null;

  const partial = await provider.fetchEntitlements(token);
  if (!partial) return null;

  const entitlements: Entitlements = {
    provider: provider.name,
    checked_at: Date.now(),
    source,
    ...partial,
  };

  // Source of truth + write-through hot-path cache.
  const credStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(provider.name));
  await credStub.putEntitlements(credential.subject_id, entitlements as unknown as Record<string, any>);
  const userStub = env.USER.get(env.USER.idFromString(credential.user_id));
  await userStub.setEntitlements(provider.name, credential.subject_id, entitlements as unknown as Record<string, any>, entitlements.checked_at);

  return entitlements;
}

/**
 * Resolve the entitlements that apply to the current request. Reads the UserDO hot-path cache first;
 * if the entry is missing or (when TTL is enabled) older than `ttlMs`, refreshes from the provider and
 * falls back to the cached value on failure. Returns null when the provider produces no entitlements.
 */
export async function loadEntitlements(opts: {
  env: StartupAPIEnv;
  provider: OAuthProvider;
  // DurableObjectStub for the current user's UserDO (already opened by the proxy).
  userStub: { getEntitlements: (provider: string, subjectId: string) => Promise<{ data: any; checked_at: number } | null> };
  userId: string;
  subjectId: string;
  ttlEnabled: boolean;
  ttlMs: number;
}): Promise<Entitlements | null> {
  const { env, provider, userStub, userId, subjectId, ttlEnabled, ttlMs } = opts;
  if (!provider.supportsEntitlements()) return null;

  const cached = await userStub.getEntitlements(provider.name, subjectId);
  const isFresh = cached && (!ttlEnabled || Date.now() - cached.checked_at < ttlMs);
  if (isFresh) return cached!.data as Entitlements;

  // Missing or stale → refresh (lazy TTL). Fall back to the cached value if the refresh fails.
  try {
    const credStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(provider.name));
    const cred = await credStub.get(subjectId);
    if (!cred) return (cached?.data as Entitlements) ?? null;
    const refreshed = await refreshEntitlements(env, provider, { ...cred, user_id: cred.user_id ?? userId }, 'oauth');
    return refreshed ?? ((cached?.data as Entitlements) ?? null);
  } catch (e) {
    console.error('[entitlements] loadEntitlements refresh failed', e);
    return (cached?.data as Entitlements) ?? null;
  }
}

/**
 * Build the entitlement-related headers forwarded to the origin app. Always includes the
 * authenticated flag; adds the login provider and a compact JSON entitlement summary when present,
 * plus provider-namespaced convenience headers for Patreon.
 */
export function entitlementHeaders(authenticated: boolean, provider?: string, entitlements?: Entitlements | null): Record<string, string> {
  const headers: Record<string, string> = { 'X-StartupAPI-Authenticated': String(authenticated) };
  if (provider) headers['X-StartupAPI-Login-Provider'] = provider;
  if (entitlements) {
    headers['X-StartupAPI-Entitlements'] = JSON.stringify(entitlements);
    if (entitlements.patreon) {
      headers['X-StartupAPI-Patreon-Active'] = String(entitlements.patreon.is_active_patron);
      if (entitlements.patreon.entitled_tier_ids.length) {
        headers['X-StartupAPI-Patreon-Tiers'] = entitlements.patreon.entitled_tier_ids.join(',');
      }
      if (entitlements.patreon.entitled_benefit_ids.length) {
        headers['X-StartupAPI-Patreon-Benefits'] = entitlements.patreon.entitled_benefit_ids.join(',');
      }
    }
  }
  return headers;
}
