import { escape as escapeHtml } from 'he';

import { ATMOSPHERE_MARK_PATH } from './atmosphereMark';
import type { StartupAPIEnv } from '../StartupAPIEnv';
import type { ProviderOptions } from '../schemas/config';

import { OAuthProvider, type AuthContext, type ExchangeResult, type OAuthTokenResponse, type UserProfile } from './OAuthProvider';
import { dpopFetch, generateDpopKey, generatePkce, randomToken } from './atproto/crypto';
import { fetchProfile, fetchSession, resolveIdentity, type ResolverOptions } from './atproto/identity';
import { DEFAULT_TYPEAHEAD_HOSTS, normalizeTypeaheadQuery, searchActorsTypeahead } from './atproto/typeahead';

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

/**
 * What the handle field accepts, as an HTML `pattern` (matched against the whole value, with the `v`
 * flag, so `-` is escaped inside classes): an atproto handle (https://atproto.com/specs/handle),
 * optionally `@`-prefixed, or a DID. The server does the real resolution; this only lets the browser
 * stop an obviously incomplete entry before it is sent.
 */
export const HANDLE_OR_DID_PATTERN = String.raw`@?([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?|did:[a-z]+:[a-zA-Z0-9._:%\-]*[a-zA-Z0-9._\-]`;

/** Hostnames that make the auth origin a local development machine (atproto loopback client mode). */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/** A string env flag is truthy when it reads as "true"/"1"/"yes"/"on" (case-insensitive). */
function isEnvFlagTruthy(value: string | undefined): boolean {
  return value !== undefined && ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Whether the atproto provider is turned on. It has no client secret (public OAuth client), so it is
 * enabled either by:
 *   - including its factory config key (`providers: { atproto: {} }`), or
 *   - setting the `ATPROTO_ENABLED` env var truthy (a per-deployment switch needing no code change).
 * A factory `atproto: { enabled: false }` is an explicit opt-out that overrides the env flag, so a
 * deployment can force the provider off regardless of the environment.
 */
export function isAtprotoEnabled(options?: ProviderOptions, env?: Pick<StartupAPIEnv, 'ATPROTO_ENABLED'>): boolean {
  if (options?.enabled === false) return false; // explicit factory opt-out always wins
  if (options !== undefined) return true; // present in the factory config
  return isEnvFlagTruthy(env?.ATPROTO_ENABLED); // otherwise honor the per-deployment env toggle
}

/**
 * AT Protocol (Atmosphere) authentication — works with any atproto PDS.
 *
 * Unlike the classic OAuth2 providers, atproto requires PKCE, DPoP-bound tokens, Pushed Authorization
 * Requests (PAR), and per-user dynamic endpoints discovered from the identity (handle → DID → PDS →
 * authorization server). It is a "public" OAuth client identified by a hosted client-metadata document
 * rather than a client id/secret. By default the document is served at the conventional domain root
 * (`/oauth-client-metadata.json`) so consent screens show just the hostname; it can instead live under
 * the auth path (`…/auth/atproto/client-metadata.json`) or be replaced by one the app owner hosts.
 *
 * On a local machine (an `http://localhost`, `127.0.0.1` or `[::1]` auth origin) no authorization
 * server can fetch that document, so the provider switches to the spec's loopback client mode: the
 * client id is `http://localhost` with the redirect URI and scope in its query string, and the
 * redirect URI uses `127.0.0.1` because the spec doesn't allow the `localhost` hostname there.
 */
export class AtprotoProvider extends OAuthProvider {
  /** Conventional root path for an atproto client-metadata document (auth servers show just the host). */
  static readonly ROOT_METADATA_PATH = '/oauth-client-metadata.json';

  /** The public client id, i.e. the URL of this client's metadata document. */
  private clientMetadataUrl = '';
  /** Path (on the auth origin) at which this worker serves the client-metadata document. */
  private metadataPath = '';
  private clientUri = '';
  private clientName = 'StartupAPI';
  private resolverOptions: ResolverOptions = {};
  /** Loopback client mode only: the `127.0.0.1` origin the whole login flow must run on. */
  private loopbackOrigin: string | null = null;
  /** Handle-autocomplete aggregators, in failover order; empty when suggestions are off. */
  private typeaheadHosts: string[] = DEFAULT_TYPEAHEAD_HOSTS;

  static create(env: StartupAPIEnv, redirectBase: string, options?: ProviderOptions): AtprotoProvider | null {
    if (!isAtprotoEnabled(options, env)) return null;
    const provider = new AtprotoProvider('', '', redirectBase + '/atproto/callback', 'atproto', options?.scopes);
    const base = new URL(redirectBase);
    // Where we serve the document: the conventional domain root (default) or under the auth path.
    const useRoot = options?.useRootOAuthClientMetadata !== false;
    provider.metadataPath = useRoot ? AtprotoProvider.ROOT_METADATA_PATH : `${base.pathname}/atproto/client-metadata.json`;
    // The client id is the URL the authorization server fetches the document from: ours, or one the app
    // owner hosts themselves (our copy under the auth path is then a reference for them to mirror).
    const custom = options?.customOAuthClientMetadataURL?.trim();
    provider.clientMetadataUrl = new URL(custom || provider.metadataPath, base.origin).toString();
    provider.clientUri = new URL(provider.clientMetadataUrl).origin;
    provider.clientName = options?.clientName?.trim() || 'StartupAPI';
    if (!custom && base.protocol === 'http:' && LOOPBACK_HOSTNAMES.includes(base.hostname)) {
      provider.useLoopbackClient(base);
    }
    provider.resolverOptions = {
      plcUrl: options?.plcUrl?.trim() || undefined,
      dohUrl: options?.dohUrl?.trim() || undefined,
    };
    if (options?.typeahead !== undefined) provider.typeaheadHosts = options.typeahead || [];
    return provider;
  }

  /**
   * Loopback client mode (local development): no client-metadata document is fetched. The client id
   * is `http://localhost` (no port or path) carrying the redirect URI and scope, and the redirect URI
   * must use an IP literal, so `localhost` becomes `127.0.0.1` while keeping the port.
   */
  private useLoopbackClient(base: URL): void {
    const redirect = new URL(this.redirectUri);
    if (redirect.hostname === 'localhost') redirect.hostname = '127.0.0.1';
    this.redirectUri = redirect.toString();
    this.loopbackOrigin = redirect.origin;
    const query = new URLSearchParams({ redirect_uri: this.redirectUri, scope: this.buildScope(['atproto']) });
    this.clientMetadataUrl = `http://localhost?${query}`;
    this.clientUri = base.origin;
  }

  getIcon(): string {
    // Atmosphere (atproto) "union" logo mark, white on the brand-blue badge.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#4a8ad4"/>
      <g transform="translate(3.2 3.2) scale(0.8)"><path fill-rule="evenodd" clip-rule="evenodd" d="${ATMOSPHERE_MARK_PATH}" fill="white"/></g>
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
    if (ctx.url.pathname === this.metadataPath) {
      return Response.json(this.getClientMetadata());
    }
    if (this.typeaheadHosts.length && ctx.url.pathname === `${ctx.authPath}/atproto/typeahead`) {
      return this.handleTypeahead(ctx);
    }
    return null;
  }

  /**
   * Handle-autocomplete proxy for the login form: `?q=` → `{ actors }` from the first aggregator that
   * answers. Responds 502 (with an empty list) when every host failed, so the form just shows nothing.
   */
  private async handleTypeahead(ctx: AuthContext): Promise<Response> {
    const q = normalizeTypeaheadQuery(ctx.url.searchParams.get('q'));
    if (!q) return Response.json({ actors: [] });
    const actors = await searchActorsTypeahead(this.typeaheadHosts, q);
    if (!actors) return Response.json({ actors: [] }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    // Answers depend only on the query, not on who asks; a short cache absorbs repeated keystrokes.
    return Response.json({ actors }, { headers: { 'Cache-Control': 'public, max-age=60' } });
  }

  /**
   * Authorization start. Requires an identifier (`?handle=`); without one we serve a small handle-entry
   * form (the standard atproto UX) so we never hardcode any authorization server. With a handle we
   * resolve the identity, run a DPoP-protected PAR, persist the flow state in an encrypted cookie, and
   * redirect to the discovered authorization endpoint.
   */
  async authorize(ctx: AuthContext): Promise<Response> {
    // Loopback client mode: the callback arrives on 127.0.0.1, so start there too. Otherwise the flow
    // cookie (and later the session cookie) would belong to `localhost` and be missing on return.
    if (this.loopbackOrigin && ctx.url.origin !== this.loopbackOrigin) {
      const target = new URL(ctx.url.pathname + ctx.url.search, this.loopbackOrigin);
      return new Response(null, { status: 302, headers: { Location: target.toString() } });
    }

    const identifier = ctx.url.searchParams.get('handle');
    const returnUrl = ctx.url.searchParams.get('return_url');
    if (!identifier || !identifier.trim()) {
      return this.renderHandleForm(ctx, returnUrl);
    }

    try {
      return await this.startAuthorization(ctx, identifier, returnUrl);
    } catch (e) {
      // The user supplied a handle and is still on our side of the redirect, so the most useful
      // recovery is to re-render the entry form with the failure shown and their handle pre-filled,
      // rather than a dead-end error page. (Callback-phase failures fall back to renderAuthError.)
      const message = e instanceof Error ? e.message : String(e);
      return this.renderHandleForm(ctx, returnUrl, { error: message, handle: identifier });
    }
  }

  /** Resolve the identity, run the DPoP-protected PAR, and redirect to the discovered auth endpoint. */
  private async startAuthorization(ctx: AuthContext, identifier: string, returnUrl: string | null): Promise<Response> {
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
    // Public profile (display name/avatar) and authenticated session info in parallel. The session
    // carries the account email only when the `account:email` permission was granted; both calls are
    // best-effort and never fail the login.
    const [{ name, picture }, session] = await Promise.all([
      fetchProfile(flow.pds, did, flow.handle),
      fetchSession(flow.pds, tokenData.access_token, flow.dpopKey),
    ]);

    const profile: UserProfile = {
      id: did,
      email: session.email,
      verified_email: session.emailConfirmed,
      name: name || flow.handle || did,
      picture,
      handle: session.handle ?? flow.handle,
    };
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

  /**
   * Handle-entry page. Shown when the user starts the flow without an identifier, and re-shown when a
   * supplied handle fails to authorize — in which case `options.error` renders an inline banner and
   * `options.handle` pre-fills the input so the user can correct and retry without leaving the page.
   */
  private renderHandleForm(ctx: AuthContext, returnUrl: string | null, options: { error?: string; handle?: string } = {}): Response {
    const action = `${ctx.authPath}/atproto`;
    const returnField = returnUrl ? `<input type="hidden" name="return_url" value="${escapeHtml(returnUrl)}" />` : '';
    const errorBanner = options.error ? `<div class="error" id="handle-error" role="alert">${escapeHtml(options.error)}</div>` : '';
    // The hint always describes the field; a failed attempt's error does too, and marks it invalid.
    const describedBy = options.error ? 'handle-hint handle-error' : 'handle-hint';
    const invalidAttr = options.error ? ' aria-invalid="true"' : '';
    const handleValue = options.handle ? ` value="${escapeHtml(options.handle)}"` : '';
    const status = options.error ? 400 : 200;
    const stylesheet = `${escapeHtml(ctx.usersPath)}style.css`;
    // The login script is progressive enhancement: it keeps Continue disabled until the field holds a
    // valid identifier, shows progress once submitted, and (with typeahead on) suggests accounts.
    // Without it the form works unchanged.
    const typeahead = this.typeaheadHosts.length > 0;
    const typeaheadAttr = typeahead ? ` data-typeahead="${escapeHtml(`${action}/typeahead`)}"` : '';
    const loginScript = `<script src="${escapeHtml(ctx.usersPath)}atproto-login.js" defer></script>`;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Login with your Atmosphere account</title>
<link rel="stylesheet" href="${stylesheet}" />
<style>
  /* Anchored near the top, not centered: suggestions grow the card downward, so Continue never moves. */
  body { margin: 0; padding: max(1rem, 15vh) 1rem 1rem; box-sizing: border-box; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; background: var(--bg); color: var(--text); }
  .auth-card { background: var(--surface); border: 1px solid var(--border); padding: 2rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); width: 23rem; max-width: 100%; box-sizing: border-box; }
  .auth-card h1 { font-size: 1rem; margin: 0 0 1rem; color: var(--text); white-space: nowrap; }
  .auth-card label { display: block; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.35rem; }
  /* 1rem keeps iOS from zooming into the field on focus. */
  .auth-card input[type=text] { width: 100%; box-sizing: border-box; padding: 0.6rem 0.7rem; border: 1px solid var(--border); border-radius: 8px; font-size: 1rem; background: var(--surface); color: var(--text); }
  .auth-card :focus-visible { outline: 2px solid #4a8ad4; outline-offset: 2px; }
  .auth-card button[type=submit] { margin-top: 1rem; width: 100%; padding: 0.65rem; border: 0; border-radius: 8px; background: #4a8ad4; color: #fff; font-size: 0.95rem; cursor: pointer; }
  .auth-card button[type=submit]:hover:not(:disabled, [aria-disabled=true]) { background: #3d77ba; }
  /* aria-disabled (not ready yet, but focusable and explains why when pressed) looks like disabled (logging in). */
  .auth-card button[type=submit]:is(:disabled, [aria-disabled=true]) { opacity: 0.55; cursor: not-allowed; }
  .auth-card[aria-busy=true] button[type=submit] { cursor: progress; }
  .auth-card p { font-size: 0.8rem; color: var(--text-muted); margin: 0.75rem 0 0; }
  .auth-card .hint { margin: 0 0 0.5rem; }
  .handle-field .selected { display: flex; align-items: center; gap: 0.6rem; padding: 0.45rem 0.6rem; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
  .handle-field .selected[hidden] { display: none; }
  .suggestions { margin-top: 1rem; }
  .suggestions[hidden] { display: none; }
  .auth-card .suggestions h2 { margin: 0 0 0.35rem; font-size: 0.85rem; font-weight: normal; color: var(--text-secondary); }
  .suggestions ul { margin: 0; padding: 0; list-style: none; }
  .suggestions button { display: flex; align-items: center; gap: 0.6rem; width: 100%; padding: 0.4rem 0.5rem; border: 0; border-radius: 6px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .suggestions button:hover, .suggestions button:focus-visible { background: var(--hover-bg); }
  .suggestions button:focus-visible { outline-offset: -2px; }
  .visually-hidden:where(:not(:focus-within, :active)) { position: absolute !important; clip-path: inset(50%) !important; overflow: hidden !important; width: 1px !important; height: 1px !important; margin: -1px !important; padding: 0 !important; border: 0 !important; white-space: nowrap !important; }
  .auth-card .avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--surface-alt); object-fit: cover; }
  .auth-card .names { min-width: 0; display: flex; flex-direction: column; }
  .auth-card .display-name { font-size: 0.9rem; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .auth-card .handle { font-size: 0.8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .auth-card .error { background: var(--danger-soft-bg); border: 1px solid var(--danger); color: var(--danger); border-radius: 8px; padding: 0.6rem 0.7rem; font-size: 0.82rem; margin-bottom: 1rem; word-break: break-word; }
</style>
</head>
<body>
  <form class="auth-card" method="GET" action="${escapeHtml(action)}">
    <h1>Login with your Atmosphere account</h1>
    ${errorBanner}
    <label for="handle">Your handle or DID</label>
    <p class="hint" id="handle-hint">For example alice.bsky.social. Your account's own server handles the login.</p>
    <div class="handle-field">
      <input type="text" id="handle" name="handle" placeholder="alice.bsky.social"${handleValue}${typeaheadAttr} pattern="${escapeHtml(HANDLE_OR_DID_PATTERN)}" aria-describedby="${describedBy}"${invalidAttr} autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus required />
    </div>
    ${returnField}
    <button type="submit">Continue</button>
  </form>
  ${loginScript}
</body>
</html>`;
    return new Response(html, {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Hardening: same-origin styles and scripts only, never framed, never cached (the form reflects
        // the user-supplied handle). With typeahead on, the script calls only our own proxy, and
        // suggestion avatars come from whichever aggregator answered, so images may load from any https
        // host. NOTE: deliberately NO `form-action` directive — submitting this form
        // hits our endpoint, which 302-redirects to the user's *own* authorization server (any PDS).
        // `form-action` is enforced across the whole redirect chain, so `'self'` (or any fixed list)
        // would block that cross-origin redirect and the login would silently fail.
        'Content-Security-Policy': typeahead
          ? "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src https:; base-uri 'none'; frame-ancestors 'none'"
          : "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    });
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
