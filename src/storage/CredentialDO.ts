import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from '../StartupAPIEnv';
import { OAuthCredentialSchema } from '../schemas/credential';
import type { OAuthCredential, OAuthCredentialOutput } from '../schemas/credential';
import { EntitlementsSchema } from '../schemas/entitlement';

/**
 * A Durable Object representing all OAuth credentials for a specific provider.
 * Each instance is identified by the provider name (e.g., "google", "twitch").
 */
export class CredentialDO extends DurableObject {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    super(state, env);
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        subject_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        profile_data TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_user_id ON credentials(user_id);
    `);

    // Entitlement columns were added after the initial schema. SQLite has no
    // "ADD COLUMN IF NOT EXISTS", so guard each ALTER and ignore the duplicate-column error.
    for (const column of ['entitlements TEXT', 'entitlements_checked_at INTEGER']) {
      try {
        this.sql.exec(`ALTER TABLE credentials ADD COLUMN ${column}`);
      } catch (_e) {
        // Column already exists.
      }
    }
  }

  /** Parse the JSON columns (profile_data, entitlements) of a credential row in place. */
  private hydrate(row: any): any {
    row.profile_data = row.profile_data ? JSON.parse(row.profile_data) : null;
    row.entitlements = row.entitlements ? JSON.parse(row.entitlements) : null;
    return row;
  }

  async get(subjectId: string): Promise<any | null> {
    const result = this.sql.exec('SELECT * FROM credentials WHERE subject_id = ?', subjectId);
    const row = result.next().value as any;
    if (!row) return null;

    return this.hydrate(row);
  }

  async list(userId: string): Promise<any[]> {
    const result = this.sql.exec('SELECT * FROM credentials WHERE user_id = ?', userId);
    const credentials = [];
    for (const row of result) {
      credentials.push(this.hydrate(row as any));
    }
    return credentials;
  }

  /**
   * Enumerate all credentials for this provider using keyset pagination on the subject_id PK.
   * Used by the scheduled cron re-sync. Returns the next cursor (last subject_id) or null when done.
   */
  async listAll(limit = 500, after?: string): Promise<{ rows: any[]; cursor: string | null }> {
    const result = after
      ? this.sql.exec('SELECT * FROM credentials WHERE subject_id > ? ORDER BY subject_id LIMIT ?', after, limit)
      : this.sql.exec('SELECT * FROM credentials ORDER BY subject_id LIMIT ?', limit);

    const rows: any[] = [];
    for (const row of result) {
      rows.push(this.hydrate(row as any));
    }
    const cursor = rows.length === limit ? (rows[rows.length - 1].subject_id as string) : null;
    return { rows, cursor };
  }

  /** Persist the entitlements blob for a credential (source of truth). */
  async putEntitlements(subjectId: string, entitlements: Record<string, any>): Promise<{ success: boolean }> {
    const validated = EntitlementsSchema.parse(entitlements);
    this.sql.exec(
      'UPDATE credentials SET entitlements = ?, entitlements_checked_at = ?, updated_at = ? WHERE subject_id = ?',
      JSON.stringify(validated),
      validated.checked_at,
      Date.now(),
      subjectId,
    );
    return { success: true };
  }

  async put(data: OAuthCredential): Promise<{ success: boolean }> {
    console.log('[auth] Parsing Cred', data);

    const validatedData: OAuthCredentialOutput = OAuthCredentialSchema.parse(data);

    console.log('[auth] Validated Cred', validatedData);

    const now = Date.now();

    this.sql.exec(
      `INSERT OR REPLACE INTO credentials 
      (subject_id, user_id, access_token, refresh_token, expires_at, scope, profile_data, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      validatedData.subject_id,
      validatedData.user_id,
      validatedData.access_token,
      validatedData.refresh_token,
      validatedData.expires_at,
      validatedData.scope,
      JSON.stringify(validatedData.profile_data),
      validatedData.created_at || now,
      now,
    );
    return { success: true };
  }

  async delete(subjectId: string): Promise<{ success: boolean }> {
    this.sql.exec('DELETE FROM credentials WHERE subject_id = ?', subjectId);
    return { success: true };
  }
}
