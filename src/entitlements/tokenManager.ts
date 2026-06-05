import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { OAuthProvider } from '../auth/OAuthProvider';

/** Refresh the access token this many ms before its actual expiry, to avoid edge-of-expiry failures. */
const EXPIRY_SKEW_MS = 60_000;

export interface StoredCredential {
  subject_id: string;
  user_id: string;
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
  profile_data?: Record<string, any> | null;
  created_at?: number | null;
}

/**
 * Return a valid access token for a stored credential, refreshing it via the provider's refresh token
 * when it has expired (or is about to). On a successful refresh the new token set is persisted back to
 * the provider's CredentialDO. Returns null when there is no usable token and refresh is impossible or
 * fails (e.g. a revoked refresh token) — callers should treat that as "entitlements unavailable" rather
 * than crash the request.
 *
 * This is the single chokepoint shared by lazy TTL refresh (hot path) and the cron re-sync.
 */
export async function getValidAccessToken(
  env: StartupAPIEnv,
  provider: OAuthProvider,
  credential: StoredCredential,
): Promise<string | null> {
  const notExpired = !credential.expires_at || Date.now() < credential.expires_at - EXPIRY_SKEW_MS;
  if (credential.access_token && notExpired) {
    return credential.access_token;
  }

  if (!credential.refresh_token) {
    // No way to refresh; fall back to the existing token (may be stale) or give up.
    return credential.access_token ?? null;
  }

  try {
    const refreshed = await provider.refreshToken(credential.refresh_token);
    if (!refreshed || !refreshed.access_token) {
      return credential.access_token ?? null;
    }

    const expiresAt = refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : undefined;

    const stub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(provider.name));
    await stub.put({
      subject_id: credential.subject_id,
      user_id: credential.user_id,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? credential.refresh_token,
      expires_at: expiresAt,
      scope: refreshed.scope ?? credential.scope ?? undefined,
      profile_data: credential.profile_data ?? undefined,
      created_at: credential.created_at ?? undefined,
    });

    return refreshed.access_token;
  } catch (e) {
    console.error(`[entitlements] Token refresh failed for ${provider.name}`, e);
    return null;
  }
}
