import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';
import { OAuthCredentialSchema } from './schemas/credential';
import type { OAuthCredential } from './schemas/credential';

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
  }

  async get(subjectId: string) {
    const result = this.sql.exec('SELECT * FROM credentials WHERE subject_id = ?', subjectId);
    const row = result.next().value as any;
    if (!row) return null;

    row.profile_data = JSON.parse(row.profile_data);
    return row;
  }

  async list(userId: string) {
    const result = this.sql.exec('SELECT * FROM credentials WHERE user_id = ?', userId);
    const credentials = [];
    for (const row of result) {
      (row as any).profile_data = JSON.parse((row as any).profile_data);
      credentials.push(row);
    }
    return credentials;
  }

  async put(data: OAuthCredential) {
    const validatedData = OAuthCredentialSchema.parse(data);
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

  async delete(subjectId: string) {
    this.sql.exec('DELETE FROM credentials WHERE subject_id = ?', subjectId);
    return { success: true };
  }
}
