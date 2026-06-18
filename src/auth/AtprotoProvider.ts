import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { ProviderOptions } from '../schemas/config';

import { OAuthProvider, type AuthContext, type ExchangeResult, type OAuthTokenResponse, type UserProfile } from './OAuthProvider';
import { dpopFetch, generateDpopKey, generatePkce, randomToken } from './atproto/crypto';
import { fetchProfile, resolveIdentity, type ResolverOptions } from './atproto/identity';

const FLOW_COOKIE = 'atproto_flow';
// Transient flow state lives only for the duration of the redirect round-trip.
const FLOW_TTL_SECONDS = 600;

/**
 * Encrypted, cookie-stored state that must survive the redirect from the authorization server back to
 * our callback: the PKCE verifier, the DPoP private key, the latest DPoP nonce, and the dynamically
 * discovered endpoints/identity for this specific user.
 */
interface AtprotoFlowState {
  state: string;
  verifier: string;
  dpopKey: JsonWebKey;
  dpopNonce?: string;
  issuer: string;
  tokenEndpoint: string;
  pds: string;
  did: string;
  handle?: string;
  returnUrl: string | null;
}

/** Whether the atproto provider is turned on. It has no client secret (public OAuth client), so it is
 *  enabled by an explicit flag rather than the presence of credentials. */
export function isAtprotoEnabled(env: StartupAPIEnv): boolean {
  const value = (env.ATPROTO_ENABLED ?? '').toString().trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes' || value === 'on';
}

/**
 * AT Protocol (Bluesky and any atproto PDS) authentication.
 *
 * Unlike the classic OAuth2 providers, atproto requires PKCE, DPoP-bound tokens, Pushed Authorization
 * Requests (PAR), and per-user dynamic endpoints discovered from the identity (handle → DID → PDS →
 * authorization server). It is a "public" OAuth client identified by a hosted client-metadata document
 * (served at `…/auth/atproto/client-metadata.json`) rather than a client id/secret.
 */
export class AtprotoProvider extends OAuthProvider {
  /** The public client id, i.e. the URL of this client's metadata document. */
  private clientMetadataUrl = '';
  private clientUri = '';
  private clientName = 'StartupAPI';
  private resolverOptions: ResolverOptions = {};

  static create(env: StartupAPIEnv, redirectBase: string, options?: ProviderOptions): AtprotoProvider | null {
    if (!isAtprotoEnabled(env)) return null;
    const provider = new AtprotoProvider('', '', redirectBase + '/atproto/callback', 'atproto', options?.scopes);
    provider.clientMetadataUrl = redirectBase + '/atproto/client-metadata.json';
    provider.clientUri = new URL(redirectBase).origin;
    provider.clientName = env.ATPROTO_CLIENT_NAME?.trim() || 'StartupAPI';
    provider.resolverOptions = {
      plcUrl: env.ATPROTO_PLC_URL?.trim() || undefined,
      dohUrl: env.ATPROTO_DOH_URL?.trim() || undefined,
    };
    return provider;
  }

  getIcon(): string {
    // AT Protocol / Bluesky butterfly mark.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="11" fill="#0085FF" stroke="white" stroke-width="1"/>
      <path d="M12 10.5C10.9 8.4 8.2 6.3 6.3 6c-1.5-.2-1.8.7-1.5 2 .2 1 1.5 5 2.3 6 .9 1.2 2 1.4 3 1.2-1.7.3-3.2 1-1.2 3 .9.9 1.6.3 2.1-.6.5-1 .8-2.1 1-2.6.2.5.5 1.6 1 2.6.5.9 1.2 1.5 2.1.6 2-2 .5-2.7-1.2-3 1 .2 2.1 0 3-1.2.8-1 2.1-5 2.3-6 .3-1.3 0-2.2-1.5-2-1.9.3-4.6 2.4-5.7 4.5z" fill="white"/>
    </svg>`;
  }

  /** The OAuth client metadata document (public client, DPoP-bound tokens). */
  getClientMetadata(): Record<string, unknown> {
    return {
      client_id: this.clientMetadataUrl,
      client_name: this.clientName,
      client_uri: this.clientUri,
      redirect_uris: [this.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: this.buildScope(['atproto']),
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    };
  }

  async handleExtraRoute(ctx: AuthContext): Promise<Response | null> {
    if (ctx.url.pathname === `${ctx.authPath}/atproto/client-metadata.json`) {
      return Response.json(this.getClientMetadata());
    }
    return null;
  }

  /**
   * Authorization start. Requires an identifier (`?handle=`); without one we serve a small handle-entry
   * form (the standard atproto UX) so we never hardcode any authorization server. With a handle we
   * resolve the identity, run a DPoP-protected PAR, persist the flow state in an encrypted cookie, and
   * redirect to the discovered authorization endpoint.
   */
  async authorize(ctx: AuthContext): Promise<Response> {
    const identifier = ctx.url.searchParams.get('handle');
    const returnUrl = ctx.url.searchParams.get('return_url');
    if (!identifier || !identifier.trim()) {
      return this.renderHandleForm(ctx, returnUrl);
    }

    const identity = await resolveIdentity(identifier, this.resolverOptions);
    const { verifier, challenge } = await generatePkce();
    const dpopKey = await generateDpopKey();
    const state = randomToken(16);
    const scope = this.buildScope(['atproto']);

    // Pushed Authorization Request: hand the request parameters to the authorization server up front
    // and receive an opaque request_uri to send the user to. DPoP is required.
    const parBody = new URLSearchParams({
      client_id: this.clientMetadataUrl,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope,
      login_hint: identity.handle ?? identity.did,
    });

    const { res, nonce } = await dpopFetch(
      identity.authServer.pushed_authorization_request_endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parBody.toString() },
      dpopKey,
    );
    if (!res.ok) {
      throw new Error(`Pushed authorization request failed: ${res.status} ${await res.text()}`);
    }
    const par = (await res.json()) as { request_uri: string };

    const flow: AtprotoFlowState = {
      state,
      verifier,
      dpopKey,
      dpopNonce: nonce,
      issuer: identity.authServer.issuer,
      tokenEndpoint: identity.authServer.token_endpoint,
      pds: identity.pds,
      did: identity.did,
      handle: identity.handle,
      returnUrl,
    };
    const encrypted = await ctx.cookieManager.encrypt(JSON.stringify(flow));

    const authUrl = new URL(identity.authServer.authorization_endpoint);
    authUrl.searchParams.set('client_id', this.clientMetadataUrl);
    authUrl.searchParams.set('request_uri', par.request_uri);

    const headers = new Headers();
    headers.set('Location', authUrl.toString());
    headers.append(
      'Set-Cookie',
      `${FLOW_COOKIE}=${encrypted}; Path=${ctx.authPath}/atproto; HttpOnly; Secure; SameSite=Lax; Max-Age=${FLOW_TTL_SECONDS}`,
    );
    return new Response(null, { status: 302, headers });
  }

  /**
   * Callback. Recover the encrypted flow state, validate `state`/`iss`, run the DPoP-protected token
   * exchange against the discovered token endpoint, then resolve a profile from the user's PDS.
   */
  async exchange(ctx: AuthContext): Promise<ExchangeResult> {
    const errorParam = ctx.url.searchParams.get('error');
    if (errorParam) {
      throw new Error(`atproto authorization error: ${errorParam} ${ctx.url.searchParams.get('error_description') ?? ''}`.trim());
    }

    const code = ctx.url.searchParams.get('code');
    if (!code) {
      const err = new Error('Missing code') as Error & { status?: number };
      err.status = 400;
      throw err;
    }

    const encrypted = readCookie(ctx.request.headers.get('Cookie'), FLOW_COOKIE);
    if (!encrypted) throw new Error('Missing atproto flow state (cookie expired or blocked)');
    const decrypted = await ctx.cookieManager.decrypt(encrypted);
    const flow = decrypted ? (JSON.parse(decrypted) as AtprotoFlowState) : null;
    if (!flow) throw new Error('Invalid atproto flow state');

    if (flow.state !== ctx.url.searchParams.get('state')) throw new Error('State mismatch');
    const iss = ctx.url.searchParams.get('iss');
    if (iss && iss !== flow.issuer) throw new Error('Issuer mismatch');

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientMetadataUrl,
      code_verifier: flow.verifier,
    });

    const { res } = await dpopFetch(
      flow.tokenEndpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() },
      flow.dpopKey,
      flow.dpopNonce,
    );
    if (!res.ok) {
      throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
    }

    const tokenData = (await res.json()) as OAuthTokenResponse & { sub?: string };
    const did = tokenData.sub || flow.did;
    const { name, picture } = await fetchProfile(flow.pds, did, flow.handle);

    const profile: UserProfile = { id: did, name: name || flow.handle || did, picture };
    const token: OAuthTokenResponse = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      scope: tokenData.scope,
      token_type: tokenData.token_type,
    };

    const clearCookie = `${FLOW_COOKIE}=; Path=${ctx.authPath}/atproto; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
    return { token, profile, returnUrl: flow.returnUrl ?? null, setCookies: [clearCookie] };
  }

  /** Minimal handle-entry page shown when the user starts the flow without an identifier. */
  private renderHandleForm(ctx: AuthContext, returnUrl: string | null): Response {
    const action = `${ctx.authPath}/atproto`;
    const returnField = returnUrl ? `<input type="hidden" name="return_url" value="${escapeHtml(returnUrl)}" />` : '';
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in with Bluesky / atproto</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f7fb; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); width: 320px; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  label { display: block; font-size: 0.85rem; color: #444; margin-bottom: 0.35rem; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; border: 1px solid #ccd2dd; border-radius: 8px; font-size: 0.95rem; }
  button { margin-top: 1rem; width: 100%; padding: 0.65rem; border: 0; border-radius: 8px; background: #0085FF; color: #fff; font-size: 0.95rem; cursor: pointer; }
  p { font-size: 0.8rem; color: #777; margin-top: 0.75rem; }
</style>
</head>
<body>
  <form class="card" method="GET" action="${escapeHtml(action)}">
    <h1>Sign in with Bluesky / atproto</h1>
    <label for="handle">Your handle or DID</label>
    <input type="text" id="handle" name="handle" placeholder="alice.bsky.social" autocomplete="username" autofocus required />
    ${returnField}
    <button type="submit">Continue</button>
    <p>Enter your atproto handle (e.g. alice.bsky.social) or DID. Your account's own server handles the login.</p>
  </form>
</body>
</html>`;
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

/** Read a single cookie value from a Cookie header, or undefined. */
function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.split('=');
    if (key.trim() === name) return rest.join('=').trim();
  }
  return undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
