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

export abstract class OAuthProvider {
  protected clientId: string;
  protected clientSecret: string;
  protected redirectUri: string;
  public name: string;
  protected additionalScopes: string[];

  constructor(clientId: string, clientSecret: string, redirectUri: string, name: string, additionalScopes: string[] = []) {
    this.clientId = clientId.trim();
    this.clientSecret = clientSecret.trim();
    this.redirectUri = redirectUri.trim();
    this.name = name.trim();
    this.additionalScopes = additionalScopes;
  }

  /**
   * Parse a configured scope string (whitespace- or comma-separated) into a list of scopes.
   * Used by providers to read extra scopes from env vars like `PATREON_SCOPES`.
   */
  static parseScopes(raw?: string | null): string[] {
    if (!raw) return [];
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
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

  protected async fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText} - ${text}`);
    }
    return response.json() as Promise<T>;
  }
}
