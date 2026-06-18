import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createStartupAPI } from '../src/createStartupAPI';
import { CookieManager } from '../src/CookieManager';

// atproto is a public OAuth client gated by an explicit flag (no client secret in the test env).
const atprotoEnv = { ...env, ATPROTO_ENABLED: 'true' } as typeof env;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/**
 * Mock the full atproto discovery + OAuth chain. `parCalls` records every PAR/token request so tests can
 * assert DPoP/PKCE behavior. The PAR endpoint deliberately demands a DPoP nonce on the first hit to
 * exercise the `use_dpop_nonce` retry.
 */
function installAtprotoMocks(opts: { onPar?: (init: RequestInit) => void; onToken?: (init: RequestInit) => void } = {}) {
  let parHits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = new Headers(init?.headers);

    if (url === 'https://alice.test/.well-known/atproto-did') {
      return new Response('did:plc:alicedid', { status: 200 });
    }
    if (url === 'https://plc.directory/did:plc:alicedid') {
      return Response.json({
        id: 'did:plc:alicedid',
        alsoKnownAs: ['at://alice.test'],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.test' }],
      });
    }
    if (url === 'https://pds.test/.well-known/oauth-protected-resource') {
      return Response.json({ authorization_servers: ['https://auth.test'] });
    }
    if (url === 'https://auth.test/.well-known/oauth-authorization-server') {
      return Response.json({
        issuer: 'https://auth.test',
        authorization_endpoint: 'https://auth.test/authorize',
        token_endpoint: 'https://auth.test/token',
        pushed_authorization_request_endpoint: 'https://auth.test/par',
      });
    }
    if (url === 'https://auth.test/par') {
      opts.onPar?.({ ...init, headers });
      parHits++;
      // First call: demand a DPoP nonce. Second call: succeed.
      if (parHits === 1) {
        return new Response(JSON.stringify({ error: 'use_dpop_nonce' }), { status: 400, headers: { 'DPoP-Nonce': 'nonce-1' } });
      }
      return new Response(JSON.stringify({ request_uri: 'urn:ietf:params:oauth:request_uri:abc', expires_in: 60 }), {
        status: 201,
        headers: { 'DPoP-Nonce': 'nonce-2' },
      });
    }
    if (url === 'https://auth.test/token') {
      opts.onToken?.({ ...init, headers });
      return Response.json({
        access_token: 'atproto-access-token',
        token_type: 'DPoP',
        refresh_token: 'atproto-refresh-token',
        expires_in: 3600,
        scope: 'atproto',
        sub: 'did:plc:alicedid',
      });
    }
    if (url.startsWith('https://pds.test/xrpc/com.atproto.repo.getRecord')) {
      return Response.json({ value: { displayName: 'Alice in AT' } });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

describe('atproto provider', () => {
  it('serves the OAuth client-metadata document', async () => {
    const api = createStartupAPI();
    const ctx = createExecutionContext();
    const res = await api.fetch(new Request('http://example.com/users/auth/atproto/client-metadata.json'), atprotoEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, any>;
    expect(meta.client_id).toBe('http://example.com/users/auth/atproto/client-metadata.json');
    expect(meta.redirect_uris).toEqual(['http://example.com/users/auth/atproto/callback']);
    expect(meta.token_endpoint_auth_method).toBe('none');
    expect(meta.dpop_bound_access_tokens).toBe(true);
    expect(meta.scope).toContain('atproto');
  });

  it('shows a handle-entry form when no identifier is provided', async () => {
    const api = createStartupAPI();
    const ctx = createExecutionContext();
    const res = await api.fetch(new Request('http://example.com/users/auth/atproto'), atprotoEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('name="handle"');
  });

  it('resolves identity, performs PAR with DPoP + PKCE (with nonce retry), and redirects', async () => {
    let parInit: RequestInit | undefined;
    let parDpopProofs = 0;
    installAtprotoMocks({
      onPar: (init) => {
        parInit = init;
        if (new Headers(init.headers).get('DPoP')) parDpopProofs++;
      },
    });

    const api = createStartupAPI();
    const ctx = createExecutionContext();
    const res = await api.fetch(
      new Request('http://example.com/users/auth/atproto?handle=alice.test&return_url=/dashboard'),
      atprotoEnv,
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe('https://auth.test/authorize');
    expect(location.searchParams.get('request_uri')).toBe('urn:ietf:params:oauth:request_uri:abc');
    expect(location.searchParams.get('client_id')).toBe('http://example.com/users/auth/atproto/client-metadata.json');

    // PAR carried a DPoP proof on each attempt and the PKCE challenge.
    expect(parDpopProofs).toBe(2);
    const parBody = new URLSearchParams((parInit!.body as string) ?? '');
    expect(parBody.get('code_challenge_method')).toBe('S256');
    expect(parBody.get('code_challenge')).toBeTruthy();
    expect(parBody.get('login_hint')).toBe('alice.test');

    // The flow state cookie was set and round-trips through CookieManager.
    const setCookie = res.headers.get('Set-Cookie') ?? '';
    expect(setCookie).toContain('atproto_flow=');
    const cookieValue = setCookie.split('atproto_flow=')[1].split(';')[0];
    const flow = JSON.parse((await new CookieManager('dev-secret').decrypt(cookieValue))!);
    expect(flow.did).toBe('did:plc:alicedid');
    expect(flow.tokenEndpoint).toBe('https://auth.test/token');
    expect(flow.returnUrl).toBe('/dashboard');
    expect(flow.dpopNonce).toBe('nonce-2');
  });

  it('completes the callback: DPoP token exchange, profile, session, and credential', async () => {
    let tokenDpop: string | null = null;
    let tokenBody: URLSearchParams | undefined;
    installAtprotoMocks({
      onToken: (init) => {
        tokenDpop = new Headers(init.headers).get('DPoP');
        tokenBody = new URLSearchParams((init.body as string) ?? '');
      },
    });

    const api = createStartupAPI();
    const cm = new CookieManager('dev-secret');

    // 1. Start the flow to obtain a valid (encrypted) flow-state cookie + its state value.
    const startCtx = createExecutionContext();
    const startRes = await api.fetch(new Request('http://example.com/users/auth/atproto?handle=alice.test'), atprotoEnv, startCtx);
    await waitOnExecutionContext(startCtx);
    const flowCookie = (startRes.headers.get('Set-Cookie') ?? '').split('atproto_flow=')[1].split(';')[0];
    const flow = JSON.parse((await cm.decrypt(flowCookie))!);

    // 2. Hit the callback with the matching state + issuer and the flow cookie.
    const cbCtx = createExecutionContext();
    const cbRes = await api.fetch(
      new Request(`http://example.com/users/auth/atproto/callback?code=authcode&state=${flow.state}&iss=https://auth.test`, {
        headers: { Cookie: `atproto_flow=${flowCookie}` },
        redirect: 'manual',
      }),
      atprotoEnv,
      cbCtx,
    );
    await waitOnExecutionContext(cbCtx);

    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get('Location')).toBe('/');

    // Token exchange was DPoP-bound and PKCE-verified.
    expect(tokenDpop).toBeTruthy();
    expect(tokenBody!.get('grant_type')).toBe('authorization_code');
    expect(tokenBody!.get('code_verifier')).toBe(flow.verifier);

    // Session cookie set; transient flow cookie cleared.
    const cookies = cbRes.headers.getSetCookie();
    expect(cookies.some((c) => c.startsWith('session_id='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('atproto_flow=') && c.includes('Max-Age=0'))).toBe(true);

    // Credential persisted under the atproto provider, keyed by DID.
    const credentialStub = atprotoEnv.CREDENTIAL.get(atprotoEnv.CREDENTIAL.idFromName('atproto'));
    const cred = await credentialStub.get('did:plc:alicedid');
    expect(cred).not.toBeNull();
    expect(cred.access_token).toBe('atproto-access-token');
    expect(cred.profile_data.name).toBe('Alice in AT');
  });

  it('rejects a callback whose state does not match the flow cookie', async () => {
    installAtprotoMocks();
    const api = createStartupAPI();

    const startCtx = createExecutionContext();
    const startRes = await api.fetch(new Request('http://example.com/users/auth/atproto?handle=alice.test'), atprotoEnv, startCtx);
    await waitOnExecutionContext(startCtx);
    const flowCookie = (startRes.headers.get('Set-Cookie') ?? '').split('atproto_flow=')[1].split(';')[0];

    const cbCtx = createExecutionContext();
    const cbRes = await api.fetch(
      new Request('http://example.com/users/auth/atproto/callback?code=authcode&state=WRONG&iss=https://auth.test', {
        headers: { Cookie: `atproto_flow=${flowCookie}` },
      }),
      atprotoEnv,
      cbCtx,
    );
    await waitOnExecutionContext(cbCtx);

    expect(cbRes.status).toBe(500);
    expect(await cbRes.text()).toContain('State mismatch');
  });

  it('lists atproto among active providers only when enabled', async () => {
    const { getActiveProviders } = await import('../src/handlers/utils');
    expect(getActiveProviders(atprotoEnv)).toContain('atproto');
    expect(getActiveProviders(env)).not.toContain('atproto');
  });
});
