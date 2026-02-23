import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';
import { UserProfileSchema } from './schemas/user';
import type { UserProfile } from './schemas/user';

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
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT,
        email TEXT,
        picture TEXT,
        provider TEXT,
        verified_email INTEGER
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

    // Ensure the single row exists
    this.sql.exec('INSERT OR IGNORE INTO profile (id) VALUES (1)');
  }

  /**
   * Validates a session ID and returns the user profile if valid.
   *
   * @param sessionId - The sessionId to validate.
   * @returns A Promise resolving to the session status and user profile.
   */
  async validateSession(
    sessionId: string,
  ): Promise<{ valid: boolean; profile?: UserProfile; credential?: Record<string, any>; error?: string }> {
    try {
      // Check session
      const sessionResult = this.sql.exec('SELECT * FROM sessions WHERE id = ?', sessionId);
      const session = sessionResult.next().value as any;

      if (!session) {
        return { valid: false };
      }

      if (session.expires_at < Date.now()) {
        return { valid: false, error: 'Expired' };
      }

      // Get profile data from local 'profile' table
      const profile = await this.getProfile();

      // Determine login context (provider and subject_id)
      const sessionMeta = session.meta ? JSON.parse(session.meta) : {};
      const loginProvider = sessionMeta.provider;
      const credential: Record<string, any> = {};

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
    } catch (_e) {
      return { valid: false };
    }
  }

  /**
   * Retrieves the user's profile data.
   *
   * @returns A Promise resolving to the user profile.
   */
  async getProfile(): Promise<UserProfile> {
    try {
      const result = this.sql.exec('SELECT * FROM profile WHERE id = 1');
      const row = result.next().value as any;
      if (!row) return {};

      return UserProfileSchema.parse({
        name: row.name,
        email: row.email,
        picture: row.picture,
        provider: row.provider,
        verified_email: row.verified_email === 1,
      });
    } catch (_e) {
      return {};
    }
  }

  /**
   * Updates the user's profile data.
   * Uses a transaction to ensure atomic updates of multiple fields.
   *
   * @param data - The JSON profile data to update.
   * @returns A Promise resolving to a success or error response.
   */
  async updateProfile(data: Record<string, any>): Promise<{ success: boolean; error?: string }> {
    try {
      const validatedData = UserProfileSchema.partial().parse(data);
      const updates: string[] = [];
      const values: any[] = [];

      if ('name' in validatedData) {
        updates.push('name = ?');
        values.push(validatedData.name);
      }
      if ('email' in validatedData) {
        updates.push('email = ?');
        values.push(validatedData.email);
      }
      if ('picture' in validatedData) {
        updates.push('picture = ?');
        values.push(validatedData.picture);
      }
      if ('provider' in validatedData) {
        updates.push('provider = ?');
        values.push(validatedData.provider);
      }
      if ('verified_email' in validatedData) {
        updates.push('verified_email = ?');
        values.push(validatedData.verified_email ? 1 : 0);
      }

      if (updates.length > 0) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE profile SET ${updates.join(', ')} WHERE id = 1`, ...values);
        });
      }
      return { success: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async addCredential(provider: string, subject_id: string): Promise<{ success: boolean }> {
    this.sql.exec('INSERT OR REPLACE INTO user_credentials (provider, subject_id) VALUES (?, ?)', provider, subject_id);
    return { success: true };
  }

  async listCredentials(): Promise<any[]> {
    const credentialsMapping = this.sql.exec('SELECT DISTINCT provider FROM user_credentials');
    const credentials = [];
    for (const row of credentialsMapping) {
      const stub = this.env.CREDENTIAL.get(this.env.CREDENTIAL.idFromName(row.provider as string));
      const providerCreds = await stub.list(this.ctx.id.toString());
      credentials.push(
        ...providerCreds.map((c: any) => ({
          provider: row.provider,
          subject_id: c.subject_id,
          email: c.profile_data?.email,
          created_at: c.created_at,
        })),
      );
    }
    return credentials;
  }

  async deleteCredential(provider: string): Promise<{ success: boolean }> {
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
  async createSession(meta?: Record<string, any>): Promise<{ sessionId: string; expiresAt: number }> {
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
  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId);
    } catch (_e) {
      // Ignore
    }
    return { success: true };
  }

  async getMemberships(): Promise<any[]> {
    try {
      const result = this.sql.exec('SELECT account_id, role, is_current FROM memberships');
      return Array.from(result);
    } catch (_e) {
      return [];
    }
  }

  async addMembership(account_id: string, role: number, is_current?: boolean): Promise<{ success: boolean }> {
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

  async deleteMembership(account_id: string): Promise<{ success: boolean }> {
    this.sql.exec('DELETE FROM memberships WHERE account_id = ?', account_id);
    return { success: true };
  }

  async switchAccount(account_id: string): Promise<{ success: boolean }> {
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
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  async getCurrentAccount(): Promise<{ account_id: string; role: number } | null> {
    const result = this.sql.exec('SELECT account_id, role FROM memberships WHERE is_current = 1');
    const membership = result.next().value as any;

    if (!membership) {
      // Fallback: Return the first membership if no current is set
      const fallback = this.sql.exec('SELECT account_id, role FROM memberships LIMIT 1');
      const fallbackMembership = fallback.next().value as any;
      if (fallbackMembership) {
        return fallbackMembership;
      }
      return null;
    }

    return membership;
  }

  async getImage(key: string): Promise<{ value: ArrayBuffer; mime_type: string } | null> {
    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    const object = await this.env.IMAGE_STORAGE.get(r2Key);
    if (!object) return null;
    return {
      value: await object.arrayBuffer(),
      mime_type: object.httpMetadata?.contentType || 'image/jpeg',
    };
  }

  async storeImage(key: string, value: ArrayBuffer, mime_type: string): Promise<{ success: boolean }> {
    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.put(r2Key, value, {
      httpMetadata: { contentType: mime_type },
    });
    return { success: true };
  }

  async deleteImage(key: string): Promise<{ success: boolean }> {
    const r2Key = `user/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.delete(r2Key);

    if (key === 'avatar') {
      this.sql.exec('UPDATE profile SET picture = NULL WHERE id = 1');
    }

    return { success: true };
  }

  async delete(): Promise<{ success: boolean }> {
    // Delete all credentials from provider-specific CredentialDOs
    const credentialsMapping = this.sql.exec('SELECT provider, subject_id FROM user_credentials');
    for (const row of credentialsMapping) {
      try {
        const stub = this.env.CREDENTIAL.get(this.env.CREDENTIAL.idFromName(row.provider as string));
        await stub.delete(row.subject_id as string);
      } catch (_e) {
        console.error(`Failed to delete credential mapping for provider ${row.provider}`, _e);
      }
    }

    // Delete all user images from R2
    const prefix = `user/${this.ctx.id.toString()}/`;
    const listed = await this.env.IMAGE_STORAGE.list({ prefix });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await this.env.IMAGE_STORAGE.delete(keys);
    }

    // Wipe all Durable Object storage
    await this.ctx.storage.deleteAll();

    return { success: true };
  }
}
