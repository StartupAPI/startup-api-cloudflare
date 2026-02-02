import type { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing a User.
 * This class handles the storage and management of user profiles,
 * OAuth2 credentials, and login sessions using a SQLite backend.
 */
export class UserDO implements DurableObject {
  state: DurableObjectState;
  env: StartupAPIEnv;
  sql: SqlStorage;

  /**
   * Initializes the User Durable Object.
   * Sets up the SQLite database schema if it doesn't already exist.
   *
   * @param state - The state of the Durable Object, including storage.
   * @param env - The environment variables and bindings.
   */
  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    // Initialize database schema
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      
      CREATE TABLE IF NOT EXISTS credentials (
        provider TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        profile_data TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        PRIMARY KEY (provider)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER,
        expires_at INTEGER,
        meta TEXT
      );

      CREATE TABLE IF NOT EXISTS images (
        key TEXT PRIMARY KEY,
        value BLOB,
        mime_type TEXT
      );

      CREATE TABLE IF NOT EXISTS memberships (
        account_id TEXT PRIMARY KEY,
        role INTEGER,
        is_current INTEGER
      );
    `);
  }

  /**
   * Handles incoming HTTP requests to the Durable Object.
   * Routes requests to the appropriate handler based on path and method.
   *
   * @param request - The incoming HTTP request.
   * @returns A Promise resolving to the HTTP response.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/profile' && method === 'GET') {
      return this.getProfile();
    } else if (path === '/profile' && method === 'POST') {
      return this.updateProfile(request);
    } else if (path === '/credentials' && method === 'POST') {
      return this.addCredential(request);
    } else if (path === '/sessions' && method === 'POST') {
      return this.createSession(request);
    } else if (path === '/sessions' && method === 'DELETE') {
      return this.deleteSession(request);
    } else if (path === '/validate-session' && method === 'POST') {
      return this.validateSession(request);
    } else if (path === '/memberships' && method === 'GET') {
      return this.getMemberships();
    } else if (path === '/memberships' && method === 'POST') {
      return this.addMembership(request);
    } else if (path === '/memberships' && method === 'DELETE') {
      return this.deleteMembership(request);
    } else if (path === '/switch-account' && method === 'POST') {
      return this.switchAccount(request);
    } else if (path.startsWith('/images/') && method === 'GET') {
      const key = path.replace('/images/', '');
      return this.getImage(key);
    } else if (path.startsWith('/images/') && method === 'PUT') {
      const key = path.replace('/images/', '');
      return this.storeImage(request, key);
    }

    return new Response('Not Found', { status: 404 });
  }

  async getImage(key: string): Promise<Response> {
    const result = this.sql.exec('SELECT value, mime_type FROM images WHERE key = ?', key);
    const row = result.next().value as any;

    if (!row) {
      return new Response('Not Found', { status: 404 });
    }

    const headers = new Headers();
    headers.set('Content-Type', row.mime_type);
    // Convert ArrayBuffer/Uint8Array to Response body
    return new Response(row.value, { headers });
  }

  async storeImage(request: Request, key: string): Promise<Response> {
    const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
    const buffer = await request.arrayBuffer();

    this.sql.exec('INSERT OR REPLACE INTO images (key, value, mime_type) VALUES (?, ?, ?)', key, buffer, contentType);
    return Response.json({ success: true });
  }

  /**
   * Validates a session ID and returns the user profile if valid.
   *
   * @param request - The HTTP request containing the sessionId.
   * @returns A Promise resolving to the session status and user profile.
   */
  async validateSession(request: Request): Promise<Response> {
    const { sessionId } = (await request.json()) as { sessionId: string };

    // Check session
    const sessionResult = this.sql.exec('SELECT * FROM sessions WHERE id = ?', sessionId);
    const session = sessionResult.next().value as any;

    if (!session) {
      return Response.json({ valid: false }, { status: 401 });
    }

    if (session.expires_at < Date.now()) {
      return Response.json({ valid: false, error: 'Expired' }, { status: 401 });
    }

    // Get latest profile data
    const credsResult = this.sql.exec('SELECT profile_data, provider FROM credentials ORDER BY updated_at DESC LIMIT 1');
    const creds = credsResult.next().value as any;

    let profile = {};
    if (creds && creds.profile_data) {
      try {
        profile = JSON.parse(creds.profile_data as string);
        // Add provider info for the UI icon
        (profile as any).provider = creds.provider;
      } catch (e) {}
    }

    return Response.json({ valid: true, profile });
  }

  /**
   * Retrieves the user's profile data.
   *
   * @returns A Promise resolving to a JSON response containing the profile key-value pairs.
   */
  async getProfile(): Promise<Response> {
    const result = this.sql.exec('SELECT key, value FROM profile');
    const profile: Record<string, any> = {};
    for (const row of result) {
      // @ts-ignore
      profile[row.key] = JSON.parse(row.value as string);
    }
    return Response.json(profile);
  }

  /**
   * Updates the user's profile data.
   * Uses a transaction to ensure atomic updates of multiple fields.
   *
   * @param request - The HTTP request containing the JSON profile data to update.
   * @returns A Promise resolving to a success or error response.
   */
  async updateProfile(request: Request): Promise<Response> {
    const data = (await request.json()) as Record<string, any>;

    try {
      this.state.storage.transactionSync(() => {
        for (const [key, value] of Object.entries(data)) {
          this.sql.exec('INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)', key, JSON.stringify(value));
        }
      });
      return Response.json({ success: true });
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  }

  /**
   * Adds or updates OAuth2 credentials for a specific provider.
   *
   * @param request - The HTTP request containing the credential details.
   * @returns A Promise resolving to a success or error response.
   */
  async addCredential(request: Request): Promise<Response> {
    const data = (await request.json()) as any;
    const { provider, subject_id, access_token, refresh_token, expires_at, scope, profile_data } = data;

    if (!provider || !subject_id) {
      return new Response('Missing provider or subject_id', { status: 400 });
    }

    const now = Date.now();

    this.sql.exec(
      `INSERT OR REPLACE INTO credentials 
      (provider, subject_id, access_token, refresh_token, expires_at, scope, profile_data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      provider,
      subject_id,
      access_token,
      refresh_token,
      expires_at,
      scope,
      JSON.stringify(profile_data),
      now,
      now,
    );

    return Response.json({ success: true });
  }

  /**
   * Creates a new login session for the user.
   * Generates a random session ID and sets a 24-hour expiration.
   *
   * @param request - The HTTP request initiating the session.
   * @returns A Promise resolving to a JSON response with the session ID and expiration time.
   */
  async createSession(request: Request): Promise<Response> {
    // Basic session creation
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    this.sql.exec('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)', sessionId, now, expiresAt);

    return Response.json({ sessionId, expiresAt });
  }

  /**
   * Deletes a login session.
   *
   * @param request - The HTTP request containing the sessionId.
   * @returns A Promise resolving to a JSON response indicating success.
   */
  async deleteSession(request: Request): Promise<Response> {
    const { sessionId } = (await request.json()) as { sessionId: string };
    this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
    return Response.json({ success: true });
  }

  async getMemberships(): Promise<Response> {
    const result = this.sql.exec('SELECT account_id, role, is_current FROM memberships');
    const memberships = Array.from(result);
    return Response.json(memberships);
  }

  async addMembership(request: Request): Promise<Response> {
    const { account_id, role, is_current } = (await request.json()) as {
      account_id: string;
      role: number;
      is_current?: boolean;
    };

    if (is_current) {
      this.sql.exec('UPDATE memberships SET is_current = 0');
    }

    this.sql.exec(
      'INSERT OR REPLACE INTO memberships (account_id, role, is_current) VALUES (?, ?, ?)',
      account_id,
      role,
      is_current ? 1 : 0,
    );
    return Response.json({ success: true });
  }

  async deleteMembership(request: Request): Promise<Response> {
    const { account_id } = (await request.json()) as { account_id: string };
    this.sql.exec('DELETE FROM memberships WHERE account_id = ?', account_id);
    return Response.json({ success: true });
  }

  async switchAccount(request: Request): Promise<Response> {
    const { account_id } = (await request.json()) as { account_id: string };

    // Verify membership exists
    const result = this.sql.exec('SELECT account_id FROM memberships WHERE account_id = ?', account_id);
    const membership = result.next().value;

    if (!membership) {
      return new Response('Membership not found', { status: 404 });
    }

    try {
      this.state.storage.transactionSync(() => {
        // Unset current
        this.sql.exec('UPDATE memberships SET is_current = 0');
        // Set new current
        this.sql.exec('UPDATE memberships SET is_current = 1 WHERE account_id = ?', account_id);
      });
      return Response.json({ success: true });
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  }
}
