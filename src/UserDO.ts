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

    let profile: Record<string, any> = {};

    // Get profile data from local 'profile' table
    const customProfileResult = this.sql.exec('SELECT key, value FROM profile');
    for (const row of customProfileResult) {
      try {
        // @ts-ignore
        profile[row.key] = JSON.parse(row.value as string);
      } catch (e) {}
    }

    // Determine login context (provider and subject_id)
    const sessionMeta = session.meta ? JSON.parse(session.meta) : {};
    const loginProvider = sessionMeta.provider;
    let credential: Record<string, any> = {};

    if (loginProvider) {
      credential.provider = loginProvider;
      const credResult = this.sql.exec('SELECT subject_id FROM user_credentials WHERE provider = ?', loginProvider);
      const credRow = credResult.next().value as any;
      if (credRow) {
        credential.subject_id = credRow.subject_id;
      }
    } else {
      // Fallback: get first available credential if no provider in session
      const credResult = this.sql.exec('SELECT provider, subject_id FROM user_credentials LIMIT 1');
      const credRow = credResult.next().value as any;
      if (credRow) {
        credential.provider = credRow.provider;
        credential.subject_id = credRow.subject_id;
      }
    }

    // Ensure the ID is set
    profile.id = this.ctx.id.toString();

    return { valid: true, profile, credential };
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

    const cred = all.find((c) => c.provider === provider);
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
   * @param meta - Optional metadata to store with the session.
   * @returns A Promise resolving to a JSON response with the session ID and expiration time.
   */
  async createSession(meta?: Record<string, any>) {
    // Basic session creation
    const sessionId = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000; // 24 hours

    this.sql.exec(
      'INSERT INTO sessions (id, created_at, expires_at, meta) VALUES (?, ?, ?, ?)',
      sessionId,
      now,
      expiresAt,
      meta ? JSON.stringify(meta) : null,
    );

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

  async getImage(key: string) {
    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    const object = await this.env.IMAGE_STORAGE.get(r2Key);
    if (!object) return null;
    return {
      value: await object.arrayBuffer(),
      mime_type: object.httpMetadata?.contentType || 'image/jpeg',
    };
  }

  async storeImage(key: string, value: ArrayBuffer, mime_type: string) {
    let finalValue = value;
    let finalMimeType = mime_type;

    if (this.env.IMAGES) {
      try {
        const input = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(value));
            controller.close();
          },
        });

        const transformer = this.env.IMAGES.input(input);
        const result = await transformer
          .transform({
            width: 300,
            height: 300,
            fit: 'cover',
          })
          .output({
            format: 'image/jpeg',
          });

        const transformedBuffer = await new Response(result.image()).arrayBuffer();
        if (transformedBuffer.byteLength > 0) {
          finalValue = transformedBuffer;
          finalMimeType = 'image/jpeg';
        }
      } catch (e) {
        console.error('Image transformation failed', e);
      }
    }

    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.put(r2Key, finalValue, {
      httpMetadata: { contentType: finalMimeType },
    });
    return { success: true };
  }

  async deleteImage(key: string) {
    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.delete(r2Key);

    if (key === 'avatar') {
      this.sql.exec("DELETE FROM profile WHERE key = 'picture'");
    }

    return { success: true };
  }

  async delete() {
    this.sql.exec('DELETE FROM profile');
    this.sql.exec('DELETE FROM sessions');
    this.sql.exec('DELETE FROM memberships');
    this.sql.exec('DELETE FROM user_credentials');

    // Delete all user images from R2
    const prefix = `user/${this.ctx.id.toString()}/`;
    const listed = await this.env.IMAGE_STORAGE.list({ prefix });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await this.env.IMAGE_STORAGE.delete(keys);
    }

    return { success: true };
  }
}
