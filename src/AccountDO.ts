import type { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing an Account (Tenant).
 * This class handles account-specific data, settings, and memberships.
 */
export class AccountDO implements DurableObject {
  state: DurableObjectState;
  env: StartupAPIEnv;
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    // Initialize database schema
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_info (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS members (
        user_id TEXT PRIMARY KEY,
        role INTEGER,
        joined_at INTEGER
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/info' && method === 'GET') {
      return this.getInfo();
    } else if (path === '/info' && method === 'POST') {
      return this.updateInfo(request);
    } else if (path === '/members' && method === 'GET') {
      return this.getMembers();
    } else if (path === '/members' && method === 'POST') {
      return this.addMember(request);
    } else if (path.startsWith('/members/') && method === 'DELETE') {
      const userId = path.replace('/members/', '');
      return this.removeMember(userId);
    }

    return new Response('Not Found', { status: 404 });
  }

  async getInfo(): Promise<Response> {
    const result = this.sql.exec('SELECT key, value FROM account_info');
    const info: Record<string, any> = {};
    for (const row of result) {
      // @ts-ignore
      info[row.key] = JSON.parse(row.value as string);
    }
    return Response.json(info);
  }

  async updateInfo(request: Request): Promise<Response> {
    const data = (await request.json()) as Record<string, any>;

    try {
      this.state.storage.transactionSync(() => {
        for (const [key, value] of Object.entries(data)) {
          this.sql.exec('INSERT OR REPLACE INTO account_info (key, value) VALUES (?, ?)', key, JSON.stringify(value));
        }
      });
      return Response.json({ success: true });
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  }

  async getMembers(): Promise<Response> {
    const result = this.sql.exec('SELECT user_id, role, joined_at FROM members');
    const members = Array.from(result);
    return Response.json(members);
  }

  async addMember(request: Request): Promise<Response> {
    const { user_id, role } = (await request.json()) as { user_id: string; role: number };
    const now = Date.now();

    this.sql.exec('INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)', user_id, role, now);
    return Response.json({ success: true });
  }

  async removeMember(userId: string): Promise<Response> {
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);
    return Response.json({ success: true });
  }
}
