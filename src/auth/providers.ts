import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { ProviderOptions } from '../schemas/config';
import { OAuthProvider } from './OAuthProvider';
import { GoogleProvider } from './GoogleProvider';
import { TwitchProvider } from './TwitchProvider';
import { PatreonProvider } from './PatreonProvider';

export type ProviderConfigs = Record<string, ProviderOptions>;

/**
 * Compute the base URL that provider callback/redirect URIs are built from, e.g.
 * `https://host/users/auth`. Mirrors the logic in handleAuth so all call sites agree.
 */
export function computeRedirectBase(env: StartupAPIEnv, origin: string, usersPath: string): string {
  const baseUsersPath = usersPath.startsWith('/') ? usersPath : '/' + usersPath;
  return new URL((baseUsersPath.endsWith('/') ? baseUsersPath : baseUsersPath + '/') + 'auth', origin).toString();
}

/**
 * Build the list of active OAuth providers (those whose credentials are configured in env). Provider
 * behavior (scopes, Patreon campaign) comes from the factory config passed as `providerConfigs`.
 */
export function createProviders(env: StartupAPIEnv, redirectBase: string, providerConfigs: ProviderConfigs = {}): OAuthProvider[] {
  return [
    GoogleProvider.create(env, redirectBase, providerConfigs.google),
    TwitchProvider.create(env, redirectBase, providerConfigs.twitch),
    PatreonProvider.create(env, redirectBase, providerConfigs.patreon),
  ].filter((p): p is OAuthProvider => p !== null);
}

/** Get a single active provider by name, or undefined if not configured. */
export function getProvider(
  env: StartupAPIEnv,
  redirectBase: string,
  name: string,
  providerConfigs: ProviderConfigs = {},
): OAuthProvider | undefined {
  return createProviders(env, redirectBase, providerConfigs).find((p) => p.name === name);
}
