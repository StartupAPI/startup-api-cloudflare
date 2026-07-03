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
  /** atproto only: the user's handle (e.g. `alice.bsky.social`), distinct from the `id` (a DID). */
  handle?: string;
}

import type { Entitlements } from '../entitlements/types';
import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { CookieManager } from '../CookieManager';

/**
 * Per-request context handed to a provider's flow hooks. Carries everything needed to run an
 * authorization start or callback without the provider reaching back into the router.
 */
export interface AuthContext {
  request: Request;
  env: StartupAPIEnv;
  url: URL;
  /** Base URL provider redirect/callback URIs are built from, e.g. `https://host/users/auth`. */
  redirectBase: string;
  /** Pathname of `redirectBase`, e.g. `/users/auth`. */
  authPath: string;
  /** Configured users path, e.g. `/users/`. */
  usersPath: string;
  /** Effective origin (AUTH_ORIGIN override or request origin). */
  origin: string;
  cookieManager: CookieManager;
  /** Login session lifetime in ms, resolved from factory config. */
  sessionTtlMs: number;
}

/**
 * Result of a successful callback exchange: the token, the resolved user profile, where to send the
 * user next, and any extra cookies to emit (e.g. clearing transient flow state).
 */
export interface ExchangeResult {
  token: OAuthTokenResponse;
  profile: UserProfile;
  returnUrl: string | null;
  setCookies?: string[];
}

/** Decode the base64url state param used by the standard flow back into its return_url. */
function parseReturnUrl(stateBase64: string | null): string | null {
  if (!stateBase64) return null;
  try {
    const base64 = stateBase64.replace(/-/g, '+').replace(/_/g, '/');
    const stateJson = decodeURIComponent(escape(atob(base64)));
    return JSON.parse(stateJson).return_url ?? null;
  } catch {
    return null;
  }
}

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

  abstract getIcon(): string;

  /**
   * Simple OAuth2 hooks used by the default {@link authorize}/{@link exchange}. Providers whose flow
   * fits the classic "redirect → code → token → profile" shape implement these. Providers with a
   * heavier flow (e.g. atproto's PKCE/DPoP/PAR) instead override {@link authorize}/{@link exchange}
   * and may leave these as the throwing defaults.
   */
  getAuthUrl(_state: string): string {
    throw new Error(`${this.name}: getAuthUrl is not implemented`);
  }

  async getToken(_code: string): Promise<OAuthTokenResponse> {
    throw new Error(`${this.name}: getToken is not implemented`);
  }

  async getUserProfile(_token: string): Promise<UserProfile> {
    throw new Error(`${this.name}: getUserProfile is not implemented`);
  }

  /**
   * Begin the authorization flow. Default: build a base64url `state` (nonce + return_url) and redirect
   * to {@link getAuthUrl}. Providers needing async setup, server-side flow state, or custom request
   * shapes override this and return their own Response.
   */
  async authorize(ctx: AuthContext): Promise<Response> {
    const returnUrl = ctx.url.searchParams.get('return_url');
    const stateObj = { nonce: Math.random().toString(36).substring(2), return_url: returnUrl };
    const state = btoa(unescape(encodeURIComponent(JSON.stringify(stateObj))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return Response.redirect(this.getAuthUrl(state), 302);
  }

  /**
   * Exchange a callback for a token and resolved profile. Default: read `code`, recover the return_url
   * from `state`, then {@link getToken} + {@link getUserProfile}. Providers override this for custom
   * token exchanges (PKCE/DPoP, dynamic endpoints, etc.).
   */
  async exchange(ctx: AuthContext): Promise<ExchangeResult> {
    const code = ctx.url.searchParams.get('code');
    if (!code) {
      const err = new Error('Missing code') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
    const returnUrl = parseReturnUrl(ctx.url.searchParams.get('state'));
    const token = await this.getToken(code);
    const profile = await this.getUserProfile(token.access_token);
    return { token, profile, returnUrl };
  }

  /**
   * Serve any provider-specific auxiliary GET routes mounted under the auth base path (e.g. the atproto
   * client-metadata document). Default: not a provider route → null, so the router moves on.
   */
  async handleExtraRoute(_ctx: AuthContext): Promise<Response | null> {
    return null;
  }

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
