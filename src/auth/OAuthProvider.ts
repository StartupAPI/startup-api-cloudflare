export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
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

  constructor(clientId: string, clientSecret: string, redirectUri: string, name: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.name = name;
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
