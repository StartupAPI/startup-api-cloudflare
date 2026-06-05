import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { getValidAccessToken } from '../src/entitlements/tokenManager';
import { PatreonProvider } from '../src/auth/PatreonProvider';

const provider = () => PatreonProvider.create(env, 'http://example.com/users/auth')!;

describe('getValidAccessToken', () => {
  it('returns the existing token without refreshing when not expired', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const token = await getValidAccessToken(env, provider(), {
        subject_id: 's-fresh',
        user_id: env.USER.newUniqueId().toString(),
        access_token: 'current',
        refresh_token: 'rt',
        expires_at: Date.now() + 3600_000,
      });
      expect(token).toBe('current');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('refreshes an expired token and persists the new token to CredentialDO', async () => {
    const subjectId = 's-refresh';
    const userId = env.USER.newUniqueId().toString();
    const stub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('patreon'));
    await stub.put({ subject_id: subjectId, user_id: userId, access_token: 'old', refresh_token: 'rt-old', expires_at: Date.now() - 1000 });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-token', refresh_token: 'rt-new', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as any,
    );

    try {
      const token = await getValidAccessToken(env, provider(), {
        subject_id: subjectId,
        user_id: userId,
        access_token: 'old',
        refresh_token: 'rt-old',
        expires_at: Date.now() - 1000,
      });
      expect(token).toBe('new-token');
      expect(fetchSpy).toHaveBeenCalledOnce();

      const updated = await stub.get(subjectId);
      expect(updated.access_token).toBe('new-token');
      expect(updated.refresh_token).toBe('rt-new');
      expect(updated.expires_at).toBeGreaterThan(Date.now());
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns null when refresh fails', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    try {
      const token = await getValidAccessToken(env, provider(), {
        subject_id: 's-fail',
        user_id: env.USER.newUniqueId().toString(),
        access_token: 'old',
        refresh_token: 'rt',
        expires_at: Date.now() - 1000,
      });
      expect(token).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
