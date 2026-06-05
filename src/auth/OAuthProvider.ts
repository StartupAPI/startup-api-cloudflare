export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
  token_type?: string;
  id_token?: string;
}

export interface UserProfile {
  id: string;
  email?: string;
  name?: string;
  picture?: string;
  verified_email?: boolean;
}

import type { Entitlements } from '../entitlements/types';

export abstract class OAuthProvider {
  protected clientId: string;
  protected clientSecret: string;
  protected redirectUri: string;
  public name: string;
  protected additionalScopes: string[];

  constructor(clientId: string, clientSecret: string, redirectUri: string, name: string, additionalScopes: string | string[] = []) {
    this.clientId = clientId.trim();
    this.clientSecret = clientSecret.trim();
    this.redirectUri = redirectUri.trim();
    this.name = name.trim();
    // Accept a single scope string or a list; buildScope() trims and dedupes.
    this.additionalScopes = Array.isArray(additionalScopes) ? additionalScopes : [additionalScopes];
  }

  /**
   * Merge a provider's required base scopes with the configured additional scopes,
   * preserving order and removing duplicates.
   */
  protected buildScope(defaultScopes: string[], separator = ' '): string {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const scope of [...defaultScopes, ...this.additionalScopes]) {
      const trimmed = scope.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        merged.push(trimmed);
      }
    }
    return merged.join(separator);
  }

  isMatch(path: string, authBasePath: string): boolean {
    return path === `${authBasePath}/${this.name}`;
  }

  isCallback(path: string, authBasePath: string): boolean {
    return path === `${authBasePath}/${this.name}/callback`;
  }

  abstract getAuthUrl(state: string): string;
  abstract getIcon(): string;
  abstract getToken(code: string): Promise<OAuthTokenResponse>;
  abstract getUserProfile(token: string): Promise<UserProfile>;

  /**
   * Whether this provider produces entitlements (memberships / perks). Providers that gate access on
   * provider-specific conditions (e.g. Patreon) override this to return true. Default: false.
   */
  supportsEntitlements(): boolean {
    return false;
  }

  /**
   * Fetch the user's current entitlements using a valid access token. Returns the provider-specific
   * portion of the {@link Entitlements} shape (without `checked_at`/`source`, which the caller stamps).
   * Default: null (provider has no entitlements).
   */
  async fetchEntitlements(_accessToken: string): Promise<Partial<Entitlements> | null> {
    return null;
  }

  /**
   * Exchange a refresh token for a fresh access token. Providers that issue refresh tokens override
   * this. Default: null (no refresh support).
   */
  async refreshToken(_refreshToken: string): Promise<OAuthTokenResponse | null> {
    return null;
  }

  protected async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText} - ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
