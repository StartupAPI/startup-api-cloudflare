/**
 * Cryptographic primitives for the AT Protocol OAuth flow: base64url helpers, PKCE, and DPoP
 * (RFC 9449) proof generation. atproto OAuth requires PKCE and sender-constrained (DPoP-bound)
 * tokens, so every request to the authorization/token endpoints carries a freshly signed ES256
 * proof-of-possession JWT. All of this runs on the WebCrypto API available in Workers.
 */

/** Encode raw bytes as unpadded base64url. */
export function base64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Encode a UTF-8 string as unpadded base64url. */
export function base64urlEncodeString(value: string): string {
  return base64urlEncode(new TextEncoder().encode(value));
}

/** A random unpadded-base64url token of `byteLength` random bytes (used for state, jti, PKCE verifier). */
export function randomToken(byteLength = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier and its S256 challenge. */
export async function generatePkce(): Promise<Pkce> {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64urlEncode(digest) };
}

const ES256_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/**
 * Generate an ephemeral ES256 (P-256) keypair for DPoP and return its private JWK. The private JWK is
 * persisted in the (encrypted) flow state so the same key can be reused for the token request and any
 * later refresh; the public half is embedded in each proof's header.
 */
export async function generateDpopKey(): Promise<JsonWebKey> {
  const pair = (await crypto.subtle.generateKey(ES256_PARAMS, true, ['sign', 'verify'])) as CryptoKeyPair;
  return (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
}

/** The public portion of a DPoP JWK, as embedded in the proof header. */
function publicJwk(jwk: JsonWebKey): JsonWebKey {
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
}

/**
 * Build a DPoP proof JWT bound to the given HTTP method and URL (htu is normalized to origin+path, per
 * RFC 9449). When the server has issued a nonce it must be echoed back in the proof.
 */
export async function createDpopProof(privateJwk: JsonWebKey, htm: string, htu: string, nonce?: string): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, ES256_PARAMS, false, ['sign']);
  const target = new URL(htu);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk(privateJwk) };
  const payload: Record<string, unknown> = {
    jti: randomToken(16),
    htm: htm.toUpperCase(),
    htu: target.origin + target.pathname,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;

  const signingInput = `${base64urlEncodeString(JSON.stringify(header))}.${base64urlEncodeString(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  // WebCrypto ECDSA already returns the raw r||s signature that JOSE/ES256 expects.
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export interface DpopResult {
  res: Response;
  /** The most recent server-issued DPoP nonce, to be reused on the next request. */
  nonce?: string;
}

/**
 * POST to a DPoP-protected endpoint, transparently handling the `use_dpop_nonce` challenge: the first
 * request is sent without (or with the cached) nonce; if the server demands a fresh nonce we retry once
 * with it. Returns the final response and the latest nonce so the caller can chain requests (PAR →
 * token) without re-fetching one.
 */
export async function dpopFetch(url: string, init: RequestInit, privateJwk: JsonWebKey, nonce?: string): Promise<DpopResult> {
  let currentNonce = nonce;
  const method = (init.method || 'POST').toUpperCase();

  for (let attempt = 0; attempt < 2; attempt++) {
    const proof = await createDpopProof(privateJwk, method, url, currentNonce);
    const headers = new Headers(init.headers);
    headers.set('DPoP', proof);
    const res = await fetch(url, { ...init, headers });
    const serverNonce = res.headers.get('DPoP-Nonce') ?? undefined;

    if ((res.status === 400 || res.status === 401) && serverNonce && attempt === 0) {
      let needsNonce = false;
      try {
        const body = (await res.clone().json()) as { error?: string };
        needsNonce = body?.error === 'use_dpop_nonce';
      } catch {
        // Non-JSON body; fall through and surface the original response.
      }
      if (needsNonce) {
        currentNonce = serverNonce;
        continue;
      }
    }

    return { res, nonce: serverNonce ?? currentNonce };
  }

  // Unreachable: the loop either returns a response or retries exactly once then returns.
  throw new Error('dpopFetch: exhausted retries');
}
