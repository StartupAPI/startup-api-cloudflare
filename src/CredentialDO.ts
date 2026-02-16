import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing a single OAuth credential.
 * Each instance is identified by "provider:subject_id".
 */
export class CredentialDO implements DurableObject {
  state: DurableObjectState;
  env: StartupAPIEnv;
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS credential (
        user_id TEXT,
        provider TEXT,
        subject_id TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        scope TEXT,
        profile_data TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (method === 'GET') {
      const result = this.sql.exec('SELECT * FROM credential LIMIT 1');
      const row = result.next().value as any;
      if (!row) return new Response('Not Found', { status: 404 });
      
      row.profile_data = JSON.parse(row.profile_data);
      return Response.json(row);
    }

    if (method === 'PUT') {
      const data = await request.json() as any;
      const now = Date.now();

      this.sql.exec(
        `INSERT OR REPLACE INTO credential 
        (user_id, provider, subject_id, access_token, refresh_token, expires_at, scope, profile_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.user_id,
        data.provider,
        data.subject_id,
        data.access_token,
        data.refresh_token,
        data.expires_at,
        data.scope,
        JSON.stringify(data.profile_data),
        data.created_at || now,
        now
      );
      return Response.json({ success: true });
    }

    if (method === 'DELETE') {
      this.sql.exec('DELETE FROM credential');
      return Response.json({ success: true });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
}
