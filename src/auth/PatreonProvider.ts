import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { ProviderOptions } from '../schemas/config';

import { OAuthProvider, OAuthTokenResponse, UserProfile } from './OAuthProvider';
import type { Entitlements } from '../entitlements/types';
import { parsePatreonIdentity } from '../entitlements/patreon';

export class PatreonProvider extends OAuthProvider {
  private campaignId?: string;
  private campaignOwnerIds: string[] = [];

  static create(env: StartupAPIEnv, redirectBase: string, options?: ProviderOptions): PatreonProvider | null {
    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) return null;
    const provider = new PatreonProvider(
      env.PATREON_CLIENT_ID,
      env.PATREON_CLIENT_SECRET,
      redirectBase + '/patreon/callback',
      'patreon',
      options?.scopes,
    );
    provider.campaignId = options?.campaignId?.trim() || undefined;
    const owners = options?.campaignOwnerId;
    provider.campaignOwnerIds = (Array.isArray(owners) ? owners : owners ? [owners] : []).map((id) => id.trim()).filter(Boolean);
    return provider;
  }

  supportsEntitlements(): boolean {
    return true;
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: this.buildScope(['identity', 'identity[email]']),
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

  async refreshToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    return this.fetchJson<OAuthTokenResponse>('https://www.patreon.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  }

  async fetchEntitlements(accessToken: string): Promise<Partial<Entitlements>> {
    const params = new URLSearchParams({
      include: 'memberships,memberships.currently_entitled_tiers,memberships.currently_entitled_tiers.benefits',
      'fields[member]': 'patron_status,currently_entitled_amount_cents',
      'fields[tier]': 'title',
      'fields[benefit]': 'title',
    });

    const data = await this.fetchJson<any>(`https://www.patreon.com/api/oauth2/v2/identity?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    return { patreon: parsePatreonIdentity(data, this.campaignId, this.campaignOwnerIds) };
  }
}
