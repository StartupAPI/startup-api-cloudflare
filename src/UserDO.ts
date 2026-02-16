import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing a User.
 * This class handles the storage and management of user profiles,
 * OAuth2 credentials, and login sessions using a SQLite backend.
 */
export class UserDO extends DurableObject {
  sql: SqlStorage;

  /**
   * Initializes the User Durable Object.
   * Sets up the SQLite database schema if it doesn't already exist.
   *
   * @param state - The state of the Durable Object, including storage.
   * @param env - The environment variables and bindings.
   */
  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    super(state, env);
    this.sql = state.storage.sql;

    // Initialize database schema
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS profile (
        key TEXT PRIMARY KEY,
        value TEXT
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

      CREATE TABLE IF NOT EXISTS user_credentials (
        provider TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (provider, subject_id)
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
      return Response.json(await this.getProfile());
    } else if (path === '/profile' && method === 'POST') {
      return Response.json(await this.updateProfile(await request.json()));
    } else if (path === '/credentials' && method === 'GET') {
      return Response.json(await this.listCredentials());
    } else if (path === '/credentials' && method === 'POST') {
      const { provider, subject_id } = await request.json() as any;
      return Response.json(await this.addCredential(provider, subject_id));
    } else if (path === '/credentials' && method === 'DELETE') {
      const { provider } = await request.json() as any;
      return Response.json(await this.deleteCredential(provider));
    } else if (path === '/sessions' && method === 'POST') {
      return Response.json(await this.createSession());
    } else if (path === '/sessions' && method === 'DELETE') {
      const { sessionId } = await request.json() as any;
      return Response.json(await this.deleteSession(sessionId));
    } else if (path === '/validate-session' && method === 'POST') {
      const { sessionId } = await request.json() as any;
      return Response.json(await this.validateSession(sessionId));
    } else if (path === '/memberships' && method === 'GET') {
      return Response.json(await this.getMemberships());
    } else if (path === '/memberships' && method === 'POST') {
      const { account_id, role, is_current } = await request.json() as any;
      return Response.json(await this.addMembership(account_id, role, is_current));
    } else if (path === '/memberships' && method === 'DELETE') {
      const { account_id } = await request.json() as any;
      return Response.json(await this.deleteMembership(account_id));
    } else if (path === '/switch-account' && method === 'POST') {
      const { account_id } = await request.json() as any;
      return Response.json(await this.switchAccount(account_id));
    } else if (path === '/current-account' && method === 'GET') {
      return Response.json(await this.getCurrentAccount());
    } else if (path.startsWith('/images/') && method === 'GET') {
      const key = path.replace('/images/', '');
      const image = await this.getImage(key);
      if (!image) return new Response('Not Found', { status: 404 });
      return new Response(image.value, { headers: { 'Content-Type': image.mime_type } });
    } else if (path.startsWith('/images/') && method === 'PUT') {
      const key = path.replace('/images/', '');
      const contentType = request.headers.get('Content-Type') || 'application/octet-stream';
      return Response.json(await this.storeImage(key, await request.arrayBuffer(), contentType));
    } else if (path === '/delete' && method === 'POST') {
      return Response.json(await this.delete());
    }

    return new Response('Not Found', { status: 404 });
  }

  async getImage(key: string) {
    const result = this.sql.exec('SELECT value, mime_type FROM images WHERE key = ?', key);
    const row = result.next().value as any;
    return row || null;
  }

  async storeImage(key: string, value: ArrayBuffer, mime_type: string) {
    this.sql.exec('INSERT OR REPLACE INTO images (key, value, mime_type) VALUES (?, ?, ?)', key, value, mime_type);
    return { success: true };
  }

  /**
   * Validates a session ID and returns the user profile if valid.
   *
   * @param sessionId - The sessionId to validate.
   * @returns A Promise resolving to the session status and user profile.
   */
  async validateSession(sessionId: string) {
    // Check session
    const sessionResult = this.sql.exec('SELECT * FROM sessions WHERE id = ?', sessionId);
    const session = sessionResult.next().value as any;

    if (!session) {
      return { valid: false };
    }

    if (session.expires_at < Date.now()) {
      return { valid: false, error: 'Expired' };
    }

    // Get latest profile data from linked credentials
    const credentialsMapping = this.sql.exec('SELECT DISTINCT provider FROM user_credentials');
    const credentials = [];
    for (const row of credentialsMapping) {
      const stub = this.env.CREDENTIAL.get(this.env.CREDENTIAL.idFromName(row.provider as string));
      const providerCreds = await stub.list(this.ctx.id.toString());
      credentials.push(...providerCreds.map((c: any) => ({ provider: row.provider, ...c })));
    }
    
    let profile: Record<string, any> = {};
    let latestCreds: any = null;

    if (credentials.length > 0) {
      // Get the most recently updated credential
      latestCreds = credentials.sort((a, b) => (b.updated_at || b.created_at) - (a.updated_at || a.created_at))[0];
      if (latestCreds && latestCreds.profile_data) {
        profile = { ...latestCreds.profile_data };
      }
    }

    // Merge with custom profile data
    const customProfileResult = this.sql.exec('SELECT key, value FROM profile');
    for (const row of customProfileResult) {
      try {
        // @ts-ignore
        profile[row.key] = JSON.parse(row.value as string);
      } catch (e) {}
    }

    // Ensure the ID and provider info are set
    profile.id = this.ctx.id.toString();
    if (latestCreds) {
      profile.provider = latestCreds.provider;
      profile.subject_id = latestCreds.subject_id;
    }

    return { valid: true, profile };
  }

  /**
   * Retrieves the user's profile data.
   *
   * @returns A Promise resolving to a JSON response containing the profile key-value pairs.
   */
  async getProfile() {
    const result = this.sql.exec('SELECT key, value FROM profile');
    const profile: Record<string, any> = {};
    for (const row of result) {
      // @ts-ignore
      profile[row.key] = JSON.parse(row.value as string);
    }
    return profile;
  }

  /**
   * Updates the user's profile data.
   * Uses a transaction to ensure atomic updates of multiple fields.
   *
   * @param data - The JSON profile data to update.
   * @returns A Promise resolving to a success or error response.
   */
  async updateProfile(data: Record<string, any>) {
    try {
      this.ctx.storage.transactionSync(() => {
        for (const [key, value] of Object.entries(data)) {
          this.sql.exec('INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)', key, JSON.stringify(value));
        }
      });
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  }

  async addCredential(provider: string, subject_id: string) {
    this.sql.exec('INSERT OR REPLACE INTO user_credentials (provider, subject_id) VALUES (?, ?)', provider, subject_id);
    return { success: true };
  }

  async listCredentials() {
    const credentialsMapping = this.sql.exec('SELECT DISTINCT provider FROM user_credentials');
    const credentials = [];
    for (const row of credentialsMapping) {
      const stub = this.env.CREDENTIAL.get(this.env.CREDENTIAL.idFromName(row.provider as string));
      const providerCreds = await stub.list(this.ctx.id.toString());
      credentials.push(...providerCreds.map((c: any) => ({ provider: row.provider, ...c })));
    }
    return credentials;
  }

  async deleteCredential(provider: string) {
    const result = this.sql.exec('SELECT provider, subject_id FROM user_credentials');
    const all = Array.from(result) as any[];

    if (all.length <= 1) {
      throw new Error('Cannot delete the last credential');
    }

    const cred = all.find(c => c.provider === provider);
    if (cred) {
      const stub = this.env.CREDENTIAL.get(this.env.CREDENTIAL.idFromName(cred.provider));
      await stub.delete(cred.subject_id);
      this.sql.exec('DELETE FROM user_credentials WHERE provider = ? AND subject_id = ?', cred.provider, cred.subject_id);
    }

    return { success: true };
  }

  /**
   * Creates a new login session for the user.
   * Generates a random session ID and sets a 24-hour expiration.
   *
   * @returns A Promise resolving to a JSON response with the session ID and expiration time.
   */
  async createSession() {
    // Basic session creation
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    this.sql.exec('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)', sessionId, now, expiresAt);

    return { sessionId, expiresAt };
  }

  /**
   * Deletes a login session.
   *
   * @param sessionId - The sessionId to delete.
   * @returns A Promise resolving to a JSON response indicating success.
   */
  async deleteSession(sessionId: string) {
    this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
    return { success: true };
  }

  async getMemberships() {
    const result = this.sql.exec('SELECT account_id, role, is_current FROM memberships');
    return Array.from(result);
  }

  async addMembership(account_id: string, role: number, is_current?: boolean) {
    if (is_current) {
      this.sql.exec('UPDATE memberships SET is_current = 0');
    }

    this.sql.exec(
      'INSERT OR REPLACE INTO memberships (account_id, role, is_current) VALUES (?, ?, ?)',
      account_id,
      role,
      is_current ? 1 : 0,
    );
    return { success: true };
  }

  async deleteMembership(account_id: string) {
    this.sql.exec('DELETE FROM memberships WHERE account_id = ?', account_id);
    return { success: true };
  }

  async switchAccount(account_id: string) {
    // Verify membership exists
    const result = this.sql.exec('SELECT account_id FROM memberships WHERE account_id = ?', account_id);
    const membership = result.next().value;

    if (!membership) {
      throw new Error('Membership not found');
    }

    try {
      this.ctx.storage.transactionSync(() => {
        // Unset current
        this.sql.exec('UPDATE memberships SET is_current = 0');
        // Set new current
        this.sql.exec('UPDATE memberships SET is_current = 1 WHERE account_id = ?', account_id);
      });
      return { success: true };
    } catch (e: any) {
      throw new Error(e.message);
    }
  }

  async getCurrentAccount() {
    const result = this.sql.exec('SELECT account_id, role FROM memberships WHERE is_current = 1');
    const membership = result.next().value;

    if (!membership) {
      // Fallback: Return the first membership if no current is set
      const fallback = this.sql.exec('SELECT account_id, role FROM memberships LIMIT 1');
      const fallbackMembership = fallback.next().value;
      if (fallbackMembership) {
        return fallbackMembership;
      }
      return null;
    }

    return membership;
  }

  async delete() {
    this.sql.exec('DELETE FROM profile');
    this.sql.exec('DELETE FROM sessions');
    this.sql.exec('DELETE FROM images');
    this.sql.exec('DELETE FROM memberships');
    this.sql.exec('DELETE FROM user_credentials');
    return { success: true };
  }
}
