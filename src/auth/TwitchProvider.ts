import { OAuthProvider, OAuthTokenResponse, UserProfile } from './OAuthProvider';

export class TwitchProvider extends OAuthProvider {
  static create(env: Env, redirectBase: string): TwitchProvider | null {
    if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) return null;
    return new TwitchProvider(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET, redirectBase + '/twitch/callback', 'twitch');
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'user:read:email',
      state: state,
    });
    return `https://id.twitch.tv/oauth2/authorize?${params.toString()}`;
  }

  getIcon(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#9146FF" stroke="white" stroke-width="1"/>
      <path d="M7 6H6v10h2v3l3-3h3l4-4V6H7zm9 6l-2 2h-3l-2 2v-2H8V7h8v5z" fill="white"/>
      <path d="M14 8.5h1.5v2H14V8.5zm-3 0h1.5v2H11v-2z" fill="white"/>
    </svg>`;
  }

  async getToken(code: string): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: this.redirectUri,
    });

    return this.fetchJson<OAuthTokenResponse>('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  }

  async getUserProfile(accessToken: string): Promise<UserProfile> {
    const data = await this.fetchJson<{ data: any[] }>('https://api.twitch.tv/helix/users', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Client-Id': this.clientId,
      },
    });

    const user = data.data[0];
    return {
      id: user.id,
      email: user.email,
      name: user.display_name,
      picture: user.profile_image_url,
    };
  }
}
