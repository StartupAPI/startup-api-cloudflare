import type { StartupAPIEnv } from '../StartupAPIEnv';

import { OAuthProvider, OAuthTokenResponse, UserProfile } from './OAuthProvider';

export class PatreonProvider extends OAuthProvider {
  static create(env: StartupAPIEnv, redirectBase: string): PatreonProvider | null {
    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) return null;
    return new PatreonProvider(env.PATREON_CLIENT_ID, env.PATREON_CLIENT_SECRET, redirectBase + '/patreon/callback', 'patreon');
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'identity identity[email]',
      state: state,
    });
    return `https://www.patreon.com/oauth2/authorize?${params.toString()}`;
  }

  getIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#FF424D" stroke="white" stroke-width="1"/>
      <circle cx="14" cy="11" r="3.5" fill="white"/>
      <rect x="6.5" y="6.5" width="2" height="11" fill="white"/>
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

    return this.fetchJson<OAuthTokenResponse>('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  }

  async getUserProfile(accessToken: string): Promise<UserProfile> {
    const params = new URLSearchParams({
      'fields[user]': 'email,full_name,image_url,is_email_verified',
    });

    const data = await this.fetchJson<{
      data: {
        id: string;
        attributes: { email?: string; full_name?: string; image_url?: string; is_email_verified?: boolean };
      };
    }>(`https://www.patreon.com/api/oauth2/v2/identity?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const user = data.data;
    return {
      id: user.id,
      email: user.attributes.email,
      name: user.attributes.full_name,
      picture: user.attributes.image_url,
      verified_email: user.attributes.is_email_verified,
    };
  }
}
