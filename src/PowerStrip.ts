/** Set by the proxy on a `data-startupapi-feature` element whose feature is off for the visitor. */
export const FEATURE_OFF_ATTRIBUTE = 'data-startupapi-feature-off';

export interface InjectPowerStripOptions {
  /**
   * Whether the request has a valid session. When given, the proxy writes it
   * onto the page's `<power-strip>` as `auth-state="signed-in|signed-out"`, so
   * the component can render the right shape on its first paint instead of
   * waiting for `/api/me`. The page then differs per visitor, so the response
   * is marked `private` for caches. Omit it to leave both untouched.
   */
  authenticated?: boolean;
  /**
   * The visitor's features, for apps that opted in with `featureDelivery.html`. The proxy writes
   * `tokens` (the delta from each feature's baseline, see `deltaTokens`) onto `<html>` as
   * `data-startupapi-features`, always, even when empty: that tells the page the proxy ran and
   * nothing differs. Elements tagged `data-startupapi-feature="<id>"` with an id in `states` get
   * `data-startupapi-feature-off` when the feature is off and lose it when it's on; other ids are
   * left as they are. It's a dedicated attribute rather than `hidden` so it never fights the app's
   * own use of `hidden` on the same element; the page hides it with one CSS rule.
   * The page then differs per visitor, so the response is marked `private` for caches.
   */
  features?: { tokens: string[]; states: Map<string, boolean> };
}

/**
 * A page that now says who is signed in must not be stored by shared caches.
 * Keeps `private` / `no-store` as they are; otherwise drops `public` and
 * `s-maxage` and adds `private` (with `no-cache` when there was no header).
 */
export function privateCacheControl(cacheControl: string | null): string {
  if (!cacheControl) {
    return 'private, no-cache';
  }
  const parts = cacheControl
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.some((part) => /^(private|no-store)$/i.test(part))) {
    return cacheControl;
  }
  return ['private', ...parts.filter((part) => !/^public$/i.test(part) && !/^s-maxage=/i.test(part))].join(', ');
}

export async function injectPowerStrip(
  response: Response,
  usersPath: string,
  providers: string[],
  options: InjectPowerStripOptions = {},
): Promise<Response> {
  const contentType = response.headers.get('Content-Type');

  if (contentType && contentType.includes('text/html')) {
    const providersAttr = providers.join(',');
    const { authenticated, features } = options;
    const authState = authenticated === undefined ? null : authenticated ? 'signed-in' : 'signed-out';
    const authStateAttr = authState ? ` auth-state="${authState}"` : '';

    // Track whether the page author placed their own <power-strip> element.
    // If they did, we respect their placement/styling and only load the script.
    let hasUserPowerStrip = false;

    let rewriter = new HTMLRewriter();
    if (features) {
      rewriter = rewriter
        .on('html', {
          element(element) {
            element.setAttribute('data-startupapi-features', features.tokens.join(' '));
          },
        })
        .on('[data-startupapi-feature]', {
          element(element) {
            const on = features.states.get(element.getAttribute('data-startupapi-feature') ?? '');
            if (on === true) element.removeAttribute(FEATURE_OFF_ATTRIBUTE);
            else if (on === false && !element.hasAttribute(FEATURE_OFF_ATTRIBUTE)) element.setAttribute(FEATURE_OFF_ATTRIBUTE, '');
          },
        });
    }

    const transformed = rewriter
      .on('power-strip', {
        element(element) {
          hasUserPowerStrip = true;

          // Fill in the active providers for the author so their element works
          // out of the box, unless they explicitly chose their own list.
          if (!element.hasAttribute('providers')) {
            element.setAttribute('providers', providersAttr);
          }

          // Tell the component who is signed in, unless the author already did.
          if (authState && !element.hasAttribute('auth-state')) {
            element.setAttribute('auth-state', authState);
          }
        },
      })
      .on('body', {
        element(element) {
          // The script is always needed to define the <power-strip> custom element.
          // It is loaded from the USERS_PATH, which is intercepted by this worker.
          element.prepend(`<script type="module" src="${usersPath}power-strip.js" async></script>`, { html: true });

          // Defer the component decision until the end of <body>, by which point
          // the streaming parser has seen any author-supplied <power-strip>.
          element.onEndTag((end) => {
            if (!hasUserPowerStrip) {
              end.before(
                `<power-strip providers="${providersAttr}"${authStateAttr} style="position: absolute; top: 0; right: 0; z-index: 9999; border-radius: 0 0 0 0.3rem;">` +
                  '<svg viewBox="0 0 24 24" style="width: 1rem; height: 1rem;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>' +
                  '</power-strip>',
                { html: true },
              );
            }
          });
        },
      })
      .transform(response);

    if (!authState && !features) {
      return transformed;
    }
    const headers = new Headers(transformed.headers);
    headers.set('Cache-Control', privateCacheControl(headers.get('Cache-Control')));
    return new Response(transformed.body, { status: transformed.status, statusText: transformed.statusText, headers });
  }

  return response;
}
