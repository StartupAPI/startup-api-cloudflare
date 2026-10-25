import { describe, it, expect } from 'vitest';
import { injectPowerStrip, privateCacheControl } from '../src/PowerStrip';

const USERS_PATH = '/users/';
const PROVIDERS = ['google', 'twitch', 'patreon'];

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/html' } });
}

// The distinctive inline style only the worker's *default* strip carries.
const DEFAULT_STRIP_STYLE = 'position: absolute; top: 0; right: 0';

// Count occurrences of the opening tag of a <power-strip> element.
function countPowerStrips(html: string): number {
  return (html.match(/<power-strip[\s/>]/g) || []).length;
}

describe('injectPowerStrip', () => {
  it('injects the script and a default strip when the page has no power-strip', async () => {
    const res = await injectPowerStrip(htmlResponse('<html><body><h1>Hi</h1></body></html>'), USERS_PATH, PROVIDERS);
    const html = await res.text();

    expect(html).toContain(`<script type="module" src="${USERS_PATH}power-strip.js" async></script>`);
    expect(html).toContain(DEFAULT_STRIP_STYLE);
    expect(html).toContain('<power-strip providers="google,twitch,patreon"');
    expect(countPowerStrips(html)).toBe(1);
  });

  it('injects only the script when the author placed their own <power-strip>', async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><nav><power-strip></power-strip></nav></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
    const html = await res.text();

    expect(html).toContain(`<script type="module" src="${USERS_PATH}power-strip.js" async></script>`);
    // No default strip appended, and the author's element is left in place.
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(countPowerStrips(html)).toBe(1);
    expect(html).toContain('<nav><power-strip');
  });

  it('auto-fills the providers attribute on a bare author element', async () => {
    const res = await injectPowerStrip(htmlResponse('<html><body><power-strip></power-strip></body></html>'), USERS_PATH, PROVIDERS);
    const html = await res.text();

    expect(html).toContain('providers="google,twitch,patreon"');
  });

  it("respects an author-specified providers attribute and doesn't override it", async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><power-strip providers="google"></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
    const html = await res.text();

    expect(html).toContain('providers="google"');
    expect(html).not.toContain('providers="google,twitch,patreon"');
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
  });

  it('detects the self-closing-style <power-strip/> the same way', async () => {
    const res = await injectPowerStrip(htmlResponse('<html><body><power-strip/></body></html>'), USERS_PATH, PROVIDERS);
    const html = await res.text();

    expect(html).toContain(`<script type="module" src="${USERS_PATH}power-strip.js" async></script>`);
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(html).toContain('providers="google,twitch,patreon"');
  });

  it('preserves the hidden attribute for the script-only opt-out', async () => {
    const res = await injectPowerStrip(htmlResponse('<html><body><power-strip hidden></power-strip></body></html>'), USERS_PATH, PROVIDERS);
    const html = await res.text();

    expect(html).toContain('hidden');
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(countPowerStrips(html)).toBe(1);
  });

  it('passes non-HTML responses through untouched', async () => {
    const original = new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
    const res = await injectPowerStrip(original, USERS_PATH, PROVIDERS);

    expect(res).toBe(original);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('keeps an author-set variant, filling in providers', async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><header><power-strip variant="compact"></power-strip></header></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
    const html = await res.text();

    expect(html).toContain('variant="compact"');
    expect(html).toContain('providers="google,twitch,patreon"');
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(countPowerStrips(html)).toBe(1);
  });

  it('writes auth-state on the author element from the session', async () => {
    const signedIn = await injectPowerStrip(
      htmlResponse('<html><body><power-strip variant="compact"></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
      { authenticated: true },
    );
    expect(await signedIn.text()).toContain('auth-state="signed-in"');

    const signedOut = await injectPowerStrip(
      htmlResponse('<html><body><power-strip variant="compact"></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
      { authenticated: false },
    );
    expect(await signedOut.text()).toContain('auth-state="signed-out"');
  });

  it("doesn't overwrite an author-set auth-state", async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><power-strip auth-state="signed-out"></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
      { authenticated: true },
    );
    const html = await res.text();

    expect(html).toContain('auth-state="signed-out"');
    expect(html).not.toContain('auth-state="signed-in"');
  });

  it('writes auth-state on the default strip too', async () => {
    const res = await injectPowerStrip(htmlResponse('<html><body><h1>Hi</h1></body></html>'), USERS_PATH, PROVIDERS, {
      authenticated: false,
    });
    const html = await res.text();

    expect(html).toContain(DEFAULT_STRIP_STYLE);
    expect(html).toContain('auth-state="signed-out"');
  });

  it('leaves auth-state and caching alone when the session is not given', async () => {
    const original = new Response('<html><body><power-strip></power-strip></body></html>', {
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' },
    });
    const res = await injectPowerStrip(original, USERS_PATH, PROVIDERS);

    expect(await res.text()).not.toContain('auth-state');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('marks a page that carries auth-state as private for caches', async () => {
    const res = await injectPowerStrip(
      new Response('<html><body><power-strip></power-strip></body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60, s-maxage=600' },
      }),
      USERS_PATH,
      PROVIDERS,
      { authenticated: true },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
    expect(res.headers.get('Content-Type')).toBe('text/html');
  });
});

describe('injectPowerStrip features', () => {
  const PAGE =
    '<html><body>' +
    '<p data-startupapi-feature="beta" data-startupapi-feature-off>Beta</p>' +
    '<p data-startupapi-feature="reports">Reports</p>' +
    '<p data-startupapi-feature="other">Other</p>' +
    '</body></html>';

  it('writes the delta on <html> and sets or removes the off attribute on tagged elements', async () => {
    const res = await injectPowerStrip(
      new Response(PAGE, { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } }),
      USERS_PATH,
      PROVIDERS,
      {
        features: {
          tokens: ['beta', '-reports'],
          states: new Map([
            ['beta', true],
            ['reports', false],
          ]),
        },
      },
    );
    const html = await res.text();

    expect(html).toContain('<html data-startupapi-features="beta -reports">');
    expect(html).toContain('<p data-startupapi-feature="beta">Beta</p>');
    expect(html).toContain('<p data-startupapi-feature="reports" data-startupapi-feature-off="">Reports</p>');
    expect(html).toContain('<p data-startupapi-feature="other">Other</p>');
    expect(html).not.toContain('auth-state');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=60');
  });

  it('leaves tagged elements alone when features are not given', async () => {
    const res = await injectPowerStrip(htmlResponse(PAGE), USERS_PATH, PROVIDERS, { authenticated: false });
    const html = await res.text();

    expect(html).not.toContain('data-startupapi-features');
    expect(html).toContain('<p data-startupapi-feature="beta" data-startupapi-feature-off>Beta</p>');
    expect(html).toContain('<p data-startupapi-feature="reports">Reports</p>');
  });
});

describe('privateCacheControl', () => {
  it('adds private, dropping public and s-maxage', () => {
    expect(privateCacheControl(null)).toBe('private, no-cache');
    expect(privateCacheControl('public, max-age=0, must-revalidate')).toBe('private, max-age=0, must-revalidate');
    expect(privateCacheControl('s-maxage=300, max-age=10')).toBe('private, max-age=10');
  });

  it('keeps headers that already rule out shared caching', () => {
    expect(privateCacheControl('private, max-age=60')).toBe('private, max-age=60');
    expect(privateCacheControl('no-store')).toBe('no-store');
  });
});
