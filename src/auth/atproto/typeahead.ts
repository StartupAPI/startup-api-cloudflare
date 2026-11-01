/**
 * Handle autocomplete for the atproto login form. A PDS has no network-wide account index, so prefix
 * search comes from an aggregator (an AppView or a dedicated typeahead service) that answers the
 * de-facto standard `app.bsky.actor.searchActorsTypeahead` XRPC call. We proxy it so the browser only
 * talks to us: the form's CSP stays `connect-src 'self'` and the aggregator never sees visitors' IPs.
 *
 * Hosts are tried in order; one that does not answer usefully (network error, timeout, non-2xx, or a
 * malformed body) is skipped in favor of the next.
 */

/** Default aggregators, tried in this order. */
export const DEFAULT_TYPEAHEAD_HOSTS = ['https://public.api.bsky.app', 'https://typeahead.waow.tech'];

/** How long to wait for one host before moving on to the next. */
const HOST_TIMEOUT_MS = 2500;
/** Suggestions returned per query. */
const TYPEAHEAD_LIMIT = 5;
/** Longest query forwarded upstream (handles are DNS names, but nobody types 253 characters). */
const MAX_QUERY_LENGTH = 100;

/** A suggestion, trimmed to what the form shows. */
export interface TypeaheadActor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/**
 * Normalize what the user typed into a search term, or null when there is nothing worth searching:
 * empty input, a DID (already exact), or something too long to be a handle prefix.
 */
export function normalizeTypeaheadQuery(raw: string | null): string | null {
  const q = (raw ?? '').trim().replace(/^@/, '');
  if (!q || q.startsWith('did:') || q.length > MAX_QUERY_LENGTH) return null;
  return q;
}

/** Keep only well-formed actors and only the fields the form shows; avatars must be https URLs. */
function sanitizeActors(body: unknown): TypeaheadActor[] | null {
  const actors = (body as { actors?: unknown } | null)?.actors;
  if (!Array.isArray(actors)) return null;
  const result: TypeaheadActor[] = [];
  for (const actor of actors) {
    if (!actor || typeof actor.did !== 'string' || typeof actor.handle !== 'string') continue;
    if (actor.handle === 'handle.invalid') continue; // the handle no longer resolves; it can't log in
    const item: TypeaheadActor = { did: actor.did, handle: actor.handle };
    if (typeof actor.displayName === 'string' && actor.displayName.trim()) item.displayName = actor.displayName.trim();
    if (typeof actor.avatar === 'string' && actor.avatar.startsWith('https://')) item.avatar = actor.avatar;
    result.push(item);
    if (result.length === TYPEAHEAD_LIMIT) break;
  }
  return result;
}

/**
 * Search the hosts in order and return the first useful answer, or null when every host failed.
 * An empty list from a host that did answer is a valid answer and stops the search.
 */
export async function searchActorsTypeahead(hosts: string[], q: string): Promise<TypeaheadActor[] | null> {
  for (const host of hosts) {
    const url = new URL('/xrpc/app.bsky.actor.searchActorsTypeahead', host);
    url.searchParams.set('q', q);
    url.searchParams.set('limit', String(TYPEAHEAD_LIMIT));
    try {
      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[atproto] typeahead host ${host} answered ${res.status}, trying the next one`);
        continue;
      }
      const actors = sanitizeActors(await res.json());
      if (actors) return actors;
      console.warn(`[atproto] typeahead host ${host} returned a malformed body, trying the next one`);
    } catch (e) {
      console.warn(`[atproto] typeahead host ${host} failed (${e instanceof Error ? e.message : String(e)}), trying the next one`);
    }
  }
  return null;
}
