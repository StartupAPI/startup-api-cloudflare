import type { StartupAPIEnv } from '../StartupAPIEnv';
import { computeRedirectBase, getProvider } from '../auth/providers';
import type { ProviderConfigs } from '../auth/providers';
import { refreshEntitlements } from './service';

/**
 * Periodically re-sync entitlements for the given providers (those that enabled cron). Pages through
 * each provider's CredentialDO with keyset pagination and refreshes every credential; per-credential
 * failures are logged and skipped so one revoked token doesn't abort the batch.
 *
 * Scale note: all credentials for a provider live in a single Durable Object, so throughput is bounded
 * by that one SQLite instance. Fine to thousands; very large bases would need work-splitting.
 */
export async function runEntitlementResync(env: StartupAPIEnv, providerNames: string[], providerConfigs: ProviderConfigs = {}): Promise<void> {
  // redirectBase is irrelevant for refresh/fetch-entitlement calls (they use tokens + client creds),
  // so a placeholder origin is fine here where there is no inbound request.
  const redirectBase = computeRedirectBase(env, env.AUTH_ORIGIN || 'https://localhost', '/users/');

  for (const name of providerNames) {
    const provider = getProvider(env, redirectBase, name, providerConfigs);
    if (!provider || !provider.supportsEntitlements()) continue;

    const credStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName(name));
    let cursor: string | null = null;
    do {
      const page: { rows: any[]; cursor: string | null } = await credStub.listAll(500, cursor ?? undefined);
      for (const cred of page.rows) {
        try {
          await refreshEntitlements(env, provider, { ...cred, user_id: cred.user_id }, 'cron');
        } catch (e) {
          console.error(`[cron] entitlement resync failed for ${name}/${cred.subject_id}`, e);
        }
      }
      cursor = page.cursor;
    } while (cursor);
  }
}
