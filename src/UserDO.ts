/**
 * A Durable Object representing a User.
 * This class handles the storage and management of user profiles,
 * OAuth2 credentials, and login sessions using a SQLite backend.
 */
export class UserDO implements DurableObject {
  state: DurableObjectState;
  env: Env;
  sql: SqlStorage;

  /**
   * Initializes the User Durable Object.
   * Sets up the SQLite database schema if it doesn't already exist.
   *
   * @param state - The state of the Durable Object, including storage.
   * @param env - The environment variables and bindings.
   */
  constructor(state: DurableObjectState, env: Env) {
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
    }

    return new Response('Not Found', { status: 404 });
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
}
