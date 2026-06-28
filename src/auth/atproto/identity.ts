/**
 * AT Protocol identity resolution. Given a user-supplied handle or DID we walk the full discovery
 * chain — with NO hardcoded provider/PDS hosts — to find the authorization server that owns the
 * identity:
 *
 *   handle ──▶ DID            (HTTPS `.well-known/atproto-did`, then DNS TXT `_atproto.<handle>` via DoH)
 *   DID    ──▶ DID document   (did:plc via a PLC directory, did:web via the domain's `.well-known`)
 *   DID doc──▶ PDS endpoint   (the `#atproto_pds` service)
 *   PDS    ──▶ auth server    (`.well-known/oauth-protected-resource` → `.well-known/oauth-authorization-server`)
 *
 * The PLC directory and DNS-over-HTTPS resolver are generic, swappable infrastructure (overridable via
 * env), not identity providers — every account hosts its own PDS and authorization server, which we
 * discover dynamically here.
 */

const DID_PREFIX = /^did:(plc|web):/;

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
  [key: string]: unknown;
}

export interface ResolvedIdentity {
  did: string;
  handle?: string;
  pds: string;
  authServer: AuthServerMetadata;
}

export interface ResolverOptions {
  /** PLC directory base URL for resolving did:plc. Defaults to the canonical https://plc.directory. */
  plcUrl?: string;
  /** DNS-over-HTTPS endpoint (RFC 8484 JSON) for the `_atproto.<handle>` TXT fallback. */
  dohUrl?: string;
}

const DEFAULT_PLC_URL = 'https://plc.directory';
const DEFAULT_DOH_URL = 'https://cloudflare-dns.com/dns-query';

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status} ${res.statusText}`);
  return res.json();
}

/** Resolve a handle to a DID via the HTTPS well-known method, falling back to DNS TXT over DoH. */
async function resolveHandleToDid(handle: string, options: ResolverOptions): Promise<string> {
  // 1. HTTPS well-known (works for any host that serves it; no third-party dependency).
  // Use `redirect: 'manual'` rather than `'error'`: the Cloudflare Workers runtime does not implement
  // the `'error'` redirect mode and throws a TypeError when it is used, which would silently disable
  // this method (and break resolution for *.bsky.social handles, which have no `_atproto` DNS record).
  // With `'manual'`, a redirected response is not followed and `res.ok` is false, so we fall through.
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, { redirect: 'manual' });
    if (res.ok) {
      const did = (await res.text()).trim();
      if (DID_PREFIX.test(did)) return did;
    }
  } catch {
    // Fall through to DNS-based resolution.
  }

  // 2. DNS TXT `_atproto.<handle>` via DNS-over-HTTPS.
  try {
    const dohUrl = new URL(options.dohUrl || DEFAULT_DOH_URL);
    dohUrl.searchParams.set('name', `_atproto.${handle}`);
    dohUrl.searchParams.set('type', 'TXT');
    const data = await fetchJson(dohUrl.toString(), { headers: { accept: 'application/dns-json' } });
    for (const answer of data.Answer ?? []) {
      const txt = String(answer.data ?? '').replace(/^"|"$/g, '');
      if (txt.startsWith('did=')) {
        const did = txt.slice(4).trim();
        if (DID_PREFIX.test(did)) return did;
      }
    }
  } catch {
    // Fall through to the error below.
  }

  throw new Error(`Could not resolve handle "${handle}" to a DID`);
}

/** Fetch and return the DID document for a did:plc or did:web identifier. */
async function resolveDidDocument(did: string, options: ResolverOptions): Promise<any> {
  if (did.startsWith('did:plc:')) {
    const base = (options.plcUrl || DEFAULT_PLC_URL).replace(/\/$/, '');
    return fetchJson(`${base}/${did}`);
  }
  if (did.startsWith('did:web:')) {
    // did:web:example.com[:path...] → https://example.com[/path...]/did.json (or /.well-known/did.json).
    const rest = did.slice('did:web:'.length);
    const segments = rest.split(':').map((s) => decodeURIComponent(s));
    const host = segments.shift();
    if (!host) throw new Error(`Malformed did:web identifier: ${did}`);
    const path = segments.length ? `/${segments.join('/')}/did.json` : '/.well-known/did.json';
    return fetchJson(`https://${host}${path}`);
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

/** Extract the PDS service endpoint from a DID document. */
function getPdsEndpoint(didDoc: any): string {
  const services: any[] = Array.isArray(didDoc?.service) ? didDoc.service : [];
  const pds = services.find(
    (s) => s?.id === '#atproto_pds' || (typeof s?.id === 'string' && s.id.endsWith('#atproto_pds')) || s?.type === 'AtprotoPersonalDataServer',
  );
  const endpoint = typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint : pds?.serviceEndpoint?.uri;
  if (!endpoint) throw new Error('DID document does not advertise an atproto PDS endpoint');
  return endpoint.replace(/\/$/, '');
}

/** Extract the primary handle (`at://<handle>`) from a DID document's alsoKnownAs, if present. */
function getHandle(didDoc: any): string | undefined {
  const aka: string[] = Array.isArray(didDoc?.alsoKnownAs) ? didDoc.alsoKnownAs : [];
  const at = aka.find((a) => typeof a === 'string' && a.startsWith('at://'));
  return at ? at.slice('at://'.length) : undefined;
}

/** Resolve a PDS to its authorization server metadata via the protected-resource indirection. */
async function resolveAuthServer(pds: string): Promise<AuthServerMetadata> {
  const protectedResource = await fetchJson(new URL('/.well-known/oauth-protected-resource', pds).toString());
  const issuer: string | undefined = protectedResource?.authorization_servers?.[0];
  if (!issuer) throw new Error(`PDS ${pds} does not declare an authorization server`);

  const metadata = (await fetchJson(new URL('/.well-known/oauth-authorization-server', issuer).toString())) as AuthServerMetadata;
  if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.pushed_authorization_request_endpoint) {
    throw new Error(`Authorization server ${issuer} is missing required OAuth endpoints (PAR is mandatory for atproto)`);
  }
  return metadata;
}

/**
 * Full identity → authorization-server resolution. Accepts a handle (optionally `@`-prefixed) or a DID.
 */
export async function resolveIdentity(input: string, options: ResolverOptions = {}): Promise<ResolvedIdentity> {
  const cleaned = input.trim().replace(/^@/, '');
  if (!cleaned) throw new Error('Empty atproto identifier');

  const isDid = cleaned.startsWith('did:');
  let handle: string | undefined = isDid ? undefined : cleaned;
  const did = isDid ? cleaned : await resolveHandleToDid(cleaned, options);

  const didDoc = await resolveDidDocument(did, options);
  const pds = getPdsEndpoint(didDoc);
  if (!handle) handle = getHandle(didDoc);

  const authServer = await resolveAuthServer(pds);
  return { did, handle, pds, authServer };
}

/**
 * Fetch a public actor profile record from the user's PDS to populate display name and avatar. Best
 * effort: getRecord is an unauthenticated read, and any failure falls back to the handle/DID.
 */
export async function fetchProfile(pds: string, did: string, handle?: string): Promise<{ name?: string; picture?: string }> {
  try {
    const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
    url.searchParams.set('repo', did);
    url.searchParams.set('collection', 'app.bsky.actor.profile');
    url.searchParams.set('rkey', 'self');

    const res = await fetch(url.toString());
    if (!res.ok) return { name: handle };

    const data = (await res.json()) as { value?: { displayName?: string; avatar?: { ref?: { $link?: string } } } };
    const value = data.value ?? {};
    let picture: string | undefined;
    const cid = value.avatar?.ref?.$link;
    if (cid) {
      const blob = new URL('/xrpc/com.atproto.sync.getBlob', pds);
      blob.searchParams.set('did', did);
      blob.searchParams.set('cid', cid);
      picture = blob.toString();
    }
    return { name: value.displayName || handle, picture };
  } catch {
    return { name: handle };
  }
}
