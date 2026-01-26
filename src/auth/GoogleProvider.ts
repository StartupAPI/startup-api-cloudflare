import { OAuthProvider, OAuthTokenResponse, UserProfile } from './OAuthProvider';

export class GoogleProvider extends OAuthProvider {
  static create(env: Env, redirectBase: string): GoogleProvider | null {
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
