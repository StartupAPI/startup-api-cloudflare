import { describe, it, expect } from 'vitest';
import { injectPowerStrip } from '../src/PowerStrip';

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

    expect(html).toContain(`<script src="${USERS_PATH}power-strip.js" async></script>`);
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

    expect(html).toContain(`<script src="${USERS_PATH}power-strip.js" async></script>`);
    // No default strip appended, and the author's element is left in place.
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(countPowerStrips(html)).toBe(1);
    expect(html).toContain('<nav><power-strip');
  });

  it('auto-fills the providers attribute on a bare author element', async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><power-strip></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
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
    const res = await injectPowerStrip(
      htmlResponse('<html><body><power-strip/></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
    const html = await res.text();

    expect(html).toContain(`<script src="${USERS_PATH}power-strip.js" async></script>`);
    expect(html).not.toContain(DEFAULT_STRIP_STYLE);
    expect(html).toContain('providers="google,twitch,patreon"');
  });

  it('preserves the hidden attribute for the script-only opt-out', async () => {
    const res = await injectPowerStrip(
      htmlResponse('<html><body><power-strip hidden></power-strip></body></html>'),
      USERS_PATH,
      PROVIDERS,
    );
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
});
