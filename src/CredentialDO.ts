import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing all OAuth credentials for a specific provider.
 * Each instance is identified by the provider name (e.g., "google", "twitch").
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/resolve' && method === 'GET') {
      const subjectId = url.searchParams.get('subject_id');
      if (!subjectId) return new Response('Missing subject_id', { status: 400 });

      const result = this.sql.exec('SELECT * FROM credentials WHERE subject_id = ?', subjectId);
      const row = result.next().value as any;
      if (!row) return new Response('Not Found', { status: 404 });
      
      row.profile_data = JSON.parse(row.profile_data);
      return Response.json(row);
    }

    if (path === '/list' && method === 'GET') {
      const userId = url.searchParams.get('user_id');
      if (!userId) return new Response('Missing user_id', { status: 400 });

      const result = this.sql.exec('SELECT * FROM credentials WHERE user_id = ?', userId);
      const credentials = [];
      for (const row of result) {
        (row as any).profile_data = JSON.parse((row as any).profile_data);
        credentials.push(row);
      }
      return Response.json(credentials);
    }

    if (method === 'PUT') {
      const data = await request.json() as any;
      const now = Date.now();

      this.sql.exec(
        `INSERT OR REPLACE INTO credentials 
        (subject_id, user_id, access_token, refresh_token, expires_at, scope, profile_data, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.subject_id,
        data.user_id,
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
      const subjectId = url.searchParams.get('subject_id');
      if (subjectId) {
        this.sql.exec('DELETE FROM credentials WHERE subject_id = ?', subjectId);
      } else {
        const userId = url.searchParams.get('user_id');
        if (userId) {
          this.sql.exec('DELETE FROM credentials WHERE user_id = ?', userId);
        }
      }
      return Response.json({ success: true });
    }

    return new Response('Method Not Allowed', { status: 405 });
  }
}
