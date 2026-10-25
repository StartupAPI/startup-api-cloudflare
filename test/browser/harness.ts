import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';

export const ORIGIN = 'http://app.test';
const COMPONENT = readFileSync(resolve(__dirname, '../../public/users/power-strip.js'), 'utf8');
// A 1×1 PNG for /users/me/avatar.
const AVATAR = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export interface Me {
  name?: string;
  email?: string;
  picture?: string | null;
  provider?: string;
  is_admin?: boolean;
  is_impersonated?: boolean;
}

export interface Account {
  account_id: string;
  name: string;
  role: number;
  is_current: number;
}

export interface MountOptions {
  /** The <power-strip> markup; defaults to a compact one for Patreon. */
  element?: string;
  /** Extra page CSS (e.g. a host theme). */
  css?: string;
  /** Signed in as this user, `null` for signed out (401), or a status code. */
  me?: Me | null | number;
  accounts?: Account[];
  /** Hold /users/api/me until the returned release() is called. */
  holdMe?: boolean;
  /** What localStorage remembers from the last visit. */
  cache?: Record<string, unknown>;
  viewport?: { width: number; height: number };
}

export const CACHE_KEY = 'startupapi:power-strip:v1:/users';

export function signedIn(overrides: Me = {}): Me {
  return {
    name: 'Jane Doe',
    email: 'jane@example.test',
    picture: null,
    provider: 'patreon',
    is_admin: false,
    is_impersonated: false,
    ...overrides,
  };
}

/** Serve a page with the component, mock the /users API, and open it. Returns
 *  the requests made and, with holdMe, a function that lets /api/me answer. */
export async function mount(page: Page, options: MountOptions = {}) {
  const {
    element = '<power-strip variant="compact" providers="patreon"></power-strip>',
    css = '',
    me = signedIn(),
    accounts = [{ account_id: 'a1', name: 'Jane Doe', role: 1, is_current: 1 }],
    holdMe = false,
    cache,
    viewport,
  } = options;
  if (viewport) await page.setViewportSize(viewport);
  const requests: string[] = [];
  const switched: unknown[] = [];
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));

  if (cache) {
    await page.addInitScript(([key, value]) => localStorage.setItem(key as string, value as string), [CACHE_KEY, JSON.stringify(cache)]);
  }

  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    switch (url.pathname) {
      case '/':
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta charset="utf-8"><style>
              body { margin: 0; font-family: sans-serif; }
              header { display: flex; align-items: center; gap: 8px; height: 48px; padding: 0 12px; }
              .spacer { flex: 1; }
              ${css}
            </style></head><body>
            <header><span>App</span><span class="spacer"></span><button id="before">Menu</button>${element}</header>
            <main style="height: 2000px"></main>
            <script type="module" src="/users/power-strip.js"></script>
          </body></html>`,
        });
      case '/users/power-strip.js':
        return route.fulfill({ contentType: 'text/javascript', body: COMPONENT });
      case '/users/api/me': {
        if (holdMe) await held;
        if (me === null) return route.fulfill({ status: 401, body: 'Unauthorized' });
        if (typeof me === 'number') return route.fulfill({ status: me, body: 'Error' });
        return route.fulfill({
          json: {
            valid: true,
            profile: { name: me.name, email: me.email, picture: me.picture, provider: me.provider, id: 'u1' },
            credential: { provider: me.provider, subject_id: 's1' },
            is_admin: me.is_admin,
            is_impersonated: me.is_impersonated,
          },
        });
      }
      case '/users/api/me/accounts':
        return route.fulfill({ json: accounts });
      case '/users/api/me/accounts/switch':
        switched.push(route.request().postDataJSON());
        return route.fulfill({ json: { ok: true } });
      case '/users/me/avatar':
        return route.fulfill({ contentType: 'image/png', body: AVATAR });
      default:
        return route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  await page.goto(`${ORIGIN}/`);
  return { requests, switched, release };
}

/** Resolves with the component's `ready` promise (the first server answer). */
export function ready(page: Page) {
  return page.evaluate(() => (document.querySelector('power-strip') as unknown as { ready: Promise<void> }).ready);
}
