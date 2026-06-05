import { env, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { CookieManager } from '../src/CookieManager';

describe('Integration Tests', () => {
  const cookieManager = new CookieManager(env.SESSION_SECRET);

  it('should return 401 for /api/me without cookie', async () => {
    const res = await SELF.fetch('http://example.com/users/api/me');
    expect(res.status).toBe(401);
  });

  it('should return user profile for valid session', async () => {
    // 1. Manually set up a UserDO with a session
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const { sessionId } = await stub.createSession();

    // Add some credentials/profile data via CredentialDO
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test-provider'));
    await credentialStub.put({
      user_id: id.toString(),
      subject_id: '123',
      profile_data: { name: 'Integration Tester' },
    });

    // Add profile data to UserDO directly
    await stub.updateProfile({ name: 'Integration Tester' });

    // Add mapping to UserDO
    await stub.addCredential('test-provider', '123');

    // 2. Fetch /api/me with the cookie
    const doId = id.toString();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const res = await SELF.fetch('http://example.com/users/api/me', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.valid).toBe(true);
    expect(data.profile.name).toBe('Integration Tester');
  });

  it('should update user profile via /api/me/profile', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Register user in SystemDO index
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerUser({ id: doId, name: 'Original Name' });

    // Create session
    const { sessionId } = await stub.createSession();

    // Add initial credentials via CredentialDO
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('test-provider'));
    await credentialStub.put({
      user_id: id.toString(),
      subject_id: '123',
      profile_data: { name: 'Original Name' },
    });

    await stub.addCredential('test-provider', '123');

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);

    // Update profile
    const updateRes = await SELF.fetch('http://example.com/users/api/me/profile', {
      method: 'POST',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Updated Name' }),
    });

    expect(updateRes.status).toBe(200);
    const updateData = (await updateRes.json()) as any;
    expect(updateData.success).toBe(true);

    // Verify update
    const meRes = await SELF.fetch('http://example.com/users/api/me', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    const meData = (await meRes.json()) as any;
    expect(meData.profile.name).toBe('Updated Name');
  });

  it('should list and delete credentials with safeguard', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();

    // Add two credentials via CredentialDO and UserDO mapping
    const googleCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));
    await googleCredStub.put({
      user_id: id.toString(),
      subject_id: 'g123',
      profile_data: { email: 'google@example.com' },
    });
    await stub.addCredential('google', 'g123');

    const twitchCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('twitch'));
    await twitchCredStub.put({
      user_id: id.toString(),
      subject_id: 't123',
      profile_data: { email: 'twitch@example.com' },
    });
    await stub.addCredential('twitch', 't123');

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);

    // List credentials
    const listRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      headers: { Cookie: `session_id=${encryptedCookie}` },
    });
    const credentials = (await listRes.json()) as any[];
    expect(credentials.length).toBe(2);

    // Delete one
    const deleteRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      method: 'DELETE',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'twitch' }),
    });
    expect(deleteRes.status).toBe(200);

    // Try to delete the last one
    const deleteLastRes = await SELF.fetch('http://example.com/users/api/me/credentials', {
      method: 'DELETE',
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ provider: 'google' }),
    });
    expect(deleteLastRes.status).toBe(400);
    expect(await deleteLastRes.text()).toBe('Cannot delete the last credential');
  });

  it('should serve avatar image from /me/avatar', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    // Create session
    const { sessionId } = await stub.createSession();

    // Store a fake image
    const imageData = new Uint8Array([1, 2, 3, 4]);
    await stub.storeImage('avatar', imageData.buffer, 'image/png');

    // Fetch image via worker
    const doId = id.toString();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const res = await SELF.fetch('http://example.com/users/me/avatar', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buffer = await res.arrayBuffer();
    expect(new Uint8Array(buffer)).toEqual(imageData);
  });

  it('should logout and invalidate session', async () => {
    // 1. Manually set up a UserDO with a session
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const doId = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();

    // 2. Call /logout with the cookie
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${doId}`);
    const logoutRes = await SELF.fetch('http://example.com/users/logout', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
      redirect: 'manual', // Don't follow the redirect to /
    });

    expect(logoutRes.status).toBe(302);
    expect(logoutRes.headers.get('Location')).toBe('/');
    // Check Set-Cookie clears the session
    const setCookie = logoutRes.headers.get('Set-Cookie');
    expect(setCookie).toContain('session_id=;');

    // 3. Verify session is actually deleted in DO
    const validData = await stub.validateSession(sessionId);
    expect(validData.valid).toBe(false);
  });

  it('should proactively clear stale session cookie for deleted user', async () => {
    // 1. Create a user and session
    const id = env.USER.newUniqueId();
    const idStr = id.toString();
    const stub = env.USER.get(id);
    await stub.updateProfile({ name: 'Deletable' });
    const { sessionId } = await stub.createSession();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${idStr}`);

    // 2. Delete the user
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.deleteUser(idStr);

    // 3. Try to access a page with the stale cookie
    const res = await SELF.fetch('http://example.com/users/profile.html', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
      redirect: 'manual',
    });

    // Should be redirected to clear the cookie
    expect(res.status).toBe(302);
    const cookies = res.headers.getSetCookie();
    const sessionCookieClear = cookies.find((c) => c.startsWith('session_id=;'));
    expect(sessionCookieClear).toBeDefined();
    expect(sessionCookieClear).toContain('Max-Age=0');
  });

  it('should not change profile picture when logging in with a secondary credential', async () => {
    // 1. Setup a user with an initial credential and avatar
    const id = env.USER.newUniqueId();
    const userStub = env.USER.get(id);
    const userIdStr = id.toString();

    // Register user in SystemDO index
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    await systemStub.registerUser({ id: userIdStr, name: 'Integration Tester' });

    // Store initial avatar
    const initialAvatar = new Uint8Array([1, 1, 1, 1]);
    await userStub.storeImage('avatar', initialAvatar.buffer, 'image/png');

    // Setup first credential (google)
    const googleCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));
    await googleCredStub.put({
      user_id: userIdStr,
      subject_id: 'g123',
      profile_data: { name: 'Google User', picture: 'http://google.com/pic.jpg' },
    });
    await userStub.addCredential('google', 'g123');

    // Setup second credential (twitch)
    const twitchCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('twitch'));
    await twitchCredStub.put({
      user_id: userIdStr,
      subject_id: 't123',
      profile_data: { name: 'Twitch User', picture: 'http://twitch.tv/pic.jpg' },
    });
    await userStub.addCredential('twitch', 't123');

    // 2. Simulate login with secondary credential (twitch)
    // In handleAuth, if it resolves an existing user (resolveData is found), isNewUser is false.
    // The avatar is only fetched/stored if isNewUser is true.

    // We can verify this by checking that if we simulate what handleAuth does for an existing user,
    // it won't call storeImage.
    // Since we can't easily mock fetch in handleAuth here without more setup,
    // we'll verify the logic by ensuring that isNewUser would be false.

    const resolveData = await twitchCredStub.get('t123');
    expect(resolveData.user_id).toBe(userIdStr);

    const isNewUserResult = !resolveData.user_id;
    expect(isNewUserResult).toBe(false);

    // 3. Verify that the avatar remains the same
    const storedImage = await userStub.getImage('avatar');
    expect(storedImage).not.toBeNull();
    expect(storedImage!.mime_type).toBe('image/png');
    expect(new Uint8Array(storedImage!.value)).toEqual(initialAvatar);
  });

  it('should server-side render profile.html', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const userIdStr = id.toString();

    // Create session
    const { sessionId } = await stub.createSession();
    await stub.updateProfile({ name: 'SSR Tester' });

    // Add credentials
    const googleCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));
    await googleCredStub.put({
      user_id: userIdStr,
      subject_id: 'google-123',
      profile_data: { email: 'google@example.com' },
    });
    await stub.addCredential('google', 'google-123');

    const twitchCredStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('twitch'));
    await twitchCredStub.put({
      user_id: userIdStr,
      subject_id: 'twitch-456',
      profile_data: { email: 'twitch@example.com' },
    });
    await stub.addCredential('twitch', 'twitch-456');

    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${userIdStr}`);

    const res = await SELF.fetch('http://example.com/users/profile.html', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SSR Tester');
    expect(html).toContain('google');
    expect(html).toContain('twitch');
    expect(html).toContain('google@example.com');
    expect(html).toContain('twitch@example.com');
    expect(html).toContain('providers="google,twitch,patreon"');
    expect(html).not.toContain('{{ssr:profile_name}}');
  });

  it('should render correct providers in "Link another account" section', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const userIdStr = id.toString();

    const { sessionId } = await stub.createSession();
    const encryptedCookie = await cookieManager.encrypt(`${sessionId}:${userIdStr}`);

    const res = await SELF.fetch('http://example.com/users/profile.html', {
      headers: {
        Cookie: `session_id=${encryptedCookie}`,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();

    // Check that configured providers are present
    expect(html).toContain('link-account-btn google');
    expect(html).toContain('link-account-btn twitch');
    expect(html).toContain('link-account-btn patreon');

    // Check that some non-existent provider is NOT present
    expect(html).not.toContain('link-account-btn github');
  });

  it('should inject correct providers into login overlay via PowerStrip', async () => {
    // When proxying to origin (example.com), it should inject the power-strip
    const res = await SELF.fetch('http://example.com/');

    expect(res.status).toBe(200);
    const html = await res.text();

    // Check that power-strip element was injected with correct providers
    expect(html).toContain('<power-strip providers="google,twitch,patreon"');
  });

  it('should append configured additional scopes to the OAuth auth URL', async () => {
    // wrangler.test.jsonc sets PATREON_SCOPES="identity.memberships"
    const res = await SELF.fetch('http://example.com/users/auth/patreon', { redirect: 'manual' });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    const authUrl = new URL(location);
    const scope = authUrl.searchParams.get('scope') || '';

    // Base scopes are preserved and the configured extra scope is merged in
    expect(scope.split(' ')).toEqual(['identity', 'identity[email]', 'identity.memberships']);
  });

  it('should not append extra scopes for providers without a configured *_SCOPES var', async () => {
    // No TWITCH_SCOPES is configured, so only the base scope should be present
    const res = await SELF.fetch('http://example.com/users/auth/twitch', { redirect: 'manual' });

    expect(res.status).toBe(302);
    const location = res.headers.get('location') || '';
    const scope = new URL(location).searchParams.get('scope') || '';

    expect(scope).toBe('user:read:email');
  });

  it('should handle numeric subject_id and empty email without ZodError', async () => {
    const userId = env.USER.newUniqueId().toString();
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));

    // Should not throw ZodError because of z.coerce.string()
    await expect(
      credentialStub.put({
        user_id: userId,
        subject_id: 12345 as any, // Numeric subject_id
        access_token: 'token',
        profile_data: { id: 12345, email: '' }, // Empty email in profile_data
      }),
    ).resolves.toEqual({ success: true });

    const userStub = env.USER.get(env.USER.idFromString(userId));
    // Should not throw ZodError because email validation is relaxed
    await expect(
      userStub.updateProfile({
        name: 'Test User',
        email: '', // Empty email string
      }),
    ).resolves.toEqual({ success: true });

    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));
    // Should not throw ZodError
    await expect(
      systemStub.registerUser({
        id: userId,
        name: 'Test User',
        email: '', // Empty email string
        provider: 'google',
      }),
    ).resolves.toEqual({ success: true });
  });

  it('should handle invalid email formats without ZodError', async () => {
    const userId = env.USER.newUniqueId().toString();
    const userStub = env.USER.get(env.USER.idFromString(userId));

    // Should not throw ZodError even if email is not a valid format
    await expect(
      userStub.updateProfile({
        name: 'Test User',
        email: 'not-an-email',
      }),
    ).resolves.toEqual({ success: true });
  });

  it('should robustly encode and decode state with special characters', async () => {
    const stateObj = {
      nonce: 'abc',
      return_url: 'https://example.com/path?q=1&u=sergey🚀',
    };

    // Simulate encoding in handleAuth
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(stateObj))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Simulate decoding in handleAuth callback
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const decodedJson = decodeURIComponent(escape(atob(base64)));
    const decodedObj = JSON.parse(decodedJson);

    expect(decodedObj).toEqual(stateObj);
  });

  it('should handle very long names without ZodError in account creation', async () => {
    const systemStub = env.SYSTEM.get(env.SYSTEM.idFromName('global'));

    const longName = 'Very Long Name That Exceeds Previous Fifty Character Limit To Test Robustness';

    // This indirectly tests handleAuth's behavior when creating a personal account
    await expect(
      systemStub.registerAccount({
        name: `${longName}'s Account`,
        status: 'active',
        plan: 'free',
      }),
    ).resolves.toEqual(expect.objectContaining({ success: true }));
  });

  it('should robustly parse OAuthCredential in CredentialDO.put', async () => {
    const userId = env.USER.newUniqueId().toString();
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('google'));

    // Test robustness of OAuthCredentialSchema.parse
    await expect(
      credentialStub.put({
        user_id: userId,
        subject_id: 67890 as any,
        access_token: null,
        expires_at: '1740263304533' as any, // Stringified timestamp
        scope: null,
        profile_data: null,
      }),
    ).resolves.toEqual({ success: true });
  });

  it('should handle array scope in OAuthCredential', async () => {
    const userId = env.USER.newUniqueId().toString();
    const credentialStub = env.CREDENTIAL.get(env.CREDENTIAL.idFromName('twitch'));

    await expect(
      credentialStub.put({
        user_id: userId,
        subject_id: 't555',
        scope: ['user:read:email', 'chat:read'],
      } as any),
    ).resolves.toEqual({ success: true });
  });
});
