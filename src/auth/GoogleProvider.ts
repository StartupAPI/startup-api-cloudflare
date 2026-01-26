import type { StartupAPIEnv } from '../StartupAPIEnv';

import { OAuthProvider, OAuthTokenResponse, UserProfile } from './OAuthProvider';

export class GoogleProvider extends OAuthProvider {
  static create(env: StartupAPIEnv, redirectBase: string): GoogleProvider | null {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
    return new GoogleProvider(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, redirectBase + '/google/callback', 'google');
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state: state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  getIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#4285F4" stroke="white" stroke-width="1"/>
      <path d="M17.64 12.2c0-.41-.03-.81-.1-1.21H12v2.3h3.16c-.14.73-.57 1.35-1.19 1.79v1.48h1.92c1.12-1.03 1.75-2.55 1.75-4.36z" fill="white"/>
      <path d="M12 18c1.62 0 2.98-.54 3.97-1.46l-1.92-1.48c-.54.37-1.23.59-2.05.59-1.57 0-2.91-1.06-3.39-2.48H6.65v1.53C7.64 16.69 9.68 18 12 18z" fill="white"/>
      <path d="M8.61 13.17c-.12-.37-.19-.76-.19-1.17s.07-.8.19-1.17V9.3H6.65c-.41.81-.65 1.73-.65 2.7s.24 1.89.65 2.7l1.96-1.53z" fill="white"/>
      <path d="M12 8.35c.88 0 1.67.3 2.3.91l1.73-1.73C14.98 6.51 13.62 6 12 6c-2.32 0-4.36 1.31-5.35 3.3L8.61 10.83c.48-1.42 1.82-2.48 3.39-2.48z" fill="white"/>
    </svg>`;
  }

  async getToken(code: string): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    return this.fetchJson<OAuthTokenResponse>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  }

  async getUserProfile(accessToken: string): Promise<UserProfile> {
    const data = await this.fetchJson<any>('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return {
      id: data.id,
      email: data.email,
      name: data.name,
      picture: data.picture,
      verified_email: data.verified_email,
    };
  }
}
