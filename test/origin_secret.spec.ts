import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createStartupAPI } from '../src/createStartupAPI';
import { AccessPolicy } from '../src/policy/accessPolicy';

// Reset the global policy so each configured instance re-initializes, and leave it uninitialized
// afterwards so other test files re-init from their own config.
beforeEach(() => AccessPolicy.reset());
afterAll(() => AccessPolicy.reset());

const SECRET = 'test-origin-secret';

// A stand-in for the origin: records each request it receives.
function originBinding() {
  return { fetch: vi.fn(async () => new Response('origin', { status: 200 })) };
}

function fetchWith(path: string, testEnv: any, config: any = {}, init: RequestInit = {}) {
  const api = createStartupAPI(config);
  const ctx = createExecutionContext();
  return api.fetch(new Request('https://app.example.org' + path, init), testEnv, ctx).then(async (res) => {
    await waitOnExecutionContext(ctx);
    return res;
  });
}

const sentSecret = (binding: ReturnType<typeof originBinding>, call = 0) =>
  (binding.fetch.mock.calls[call] as unknown as [Request])[0].headers.get('X-StartupAPI-Origin-Secret');

describe('ORIGIN_SECRET', () => {
  it('is sent to the origin on proxied requests', async () => {
    const binding = originBinding();
    await fetchWith('/page', { ...env, ORIGIN: binding, ORIGIN_URL: '', ORIGIN_SECRET: SECRET });
    expect(sentSecret(binding)).toBe(SECRET);
  });

  it('is not sent when ORIGIN_SECRET is unset', async () => {
    const binding = originBinding();
    await fetchWith('/page', { ...env, ORIGIN: binding, ORIGIN_URL: '' });
    expect(sentSecret(binding)).toBeNull();
  });

  it("replaces a visitor's forged value", async () => {
    const binding = originBinding();
    const headers = { 'X-StartupAPI-Origin-Secret': 'forged' };
    await fetchWith('/page', { ...env, ORIGIN: binding, ORIGIN_URL: '', ORIGIN_SECRET: SECRET }, {}, { headers });
    expect(sentSecret(binding)).toBe(SECRET);
  });

  it("drops a visitor's forged value when ORIGIN_SECRET is unset", async () => {
    const binding = originBinding();
    const headers = { 'X-StartupAPI-Origin-Secret': 'forged' };
    await fetchWith('/page', { ...env, ORIGIN: binding, ORIGIN_URL: '' }, {}, { headers });
    expect(sentSecret(binding)).toBeNull();
  });

  it('is sent on bypass paths too', async () => {
    const binding = originBinding();
    const policy = { rules: [{ pattern: '/raw', requirement: { mode: 'bypass' as const } }], default: { mode: 'public' as const } };
    await fetchWith('/raw', { ...env, ORIGIN: binding, ORIGIN_URL: '', ORIGIN_SECRET: SECRET }, { accessPolicy: policy });
    expect(sentSecret(binding)).toBe(SECRET);
  });

  it('is sent with origin-sourced gate pages', async () => {
    const binding = originBinding();
    const policy = {
      rules: [
        {
          pattern: '/members',
          requirement: { mode: 'authenticated' as const },
          on_unauthorized: 'gate' as const,
          gate: { anonymous: { origin: '/please-log-in' } },
        },
      ],
      default: { mode: 'public' as const },
    };
    await fetchWith('/members', { ...env, ORIGIN: binding, ORIGIN_URL: '', ORIGIN_SECRET: SECRET }, { accessPolicy: policy });
    expect(new URL((binding.fetch.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe('/please-log-in');
    expect(sentSecret(binding)).toBe(SECRET);
  });

  it('is never returned to the visitor', async () => {
    const binding = originBinding();
    const res = await fetchWith('/page', { ...env, ORIGIN: binding, ORIGIN_URL: '', ORIGIN_SECRET: SECRET });
    for (const [, value] of res.headers) expect(value).not.toContain(SECRET);
    expect(await res.text()).not.toContain(SECRET);
  });
});
