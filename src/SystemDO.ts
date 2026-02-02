import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';

export class SystemDO implements DurableObject {
  state: DurableObjectState;
  env: StartupAPIEnv;
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        provider TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        plan TEXT,
        created_at INTEGER
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/users') {
      if (method === 'GET') return this.listUsers(url.searchParams);
      if (method === 'POST') return this.registerUser(request);
    } else if (path.startsWith('/users/')) {
       const userId = path.substring('/users/'.length);
       if (userId) {
          if (method === 'GET') return this.getUser(userId);
          if (method === 'PUT') return this.updateUser(request, userId);
       }
    } else if (path === '/accounts') {
      if (method === 'GET') return this.listAccounts(url.searchParams);
      if (method === 'POST') return this.registerAccount(request);
    } else if (path.startsWith('/accounts/')) {
        const accountId = path.substring('/accounts/'.length);
        if (accountId) {
            if (method === 'GET') return this.getAccount(accountId);
            if (method === 'PUT') return this.updateAccount(request, accountId);
        }
    }

    return new Response('Not Found', { status: 404 });
  }

  async listUsers(params: URLSearchParams): Promise<Response> {
    const query = params.get('q');
    let sql = 'SELECT * FROM users';
    const args: any[] = [];

    if (query) {
      sql += ' WHERE name LIKE ? OR email LIKE ?';
      args.push(`%${query}%`, `%${query}%`);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';

    const result = this.sql.exec(sql, ...args);
    const users = Array.from(result);
    return Response.json(users);
  }

  async getUser(userId: string): Promise<Response> {
     try {
         const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
         const profileRes = await userStub.fetch('http://do/profile');
         if (!profileRes.ok) return profileRes;
         
         const profile = await profileRes.json();
         return Response.json(profile);
     } catch (e: any) {
         return new Response(e.message, { status: 500 });
     }
  }

  async registerUser(request: Request): Promise<Response> {
    const data = (await request.json()) as {
      id: string;
      name: string;
      email?: string;
      provider?: string;
    };
    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO users (id, name, email, provider, created_at) VALUES (?, ?, ?, ?, ?)',
      data.id,
      data.name,
      data.email || null,
      data.provider || null,
      now,
    );

    return Response.json({ success: true });
  }

  async updateUser(request: Request, userId: string): Promise<Response> {
    const data = (await request.json()) as any;
    
    // Update UserDO
    try {
        const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
        await userStub.fetch('http://do/profile', { method: 'POST', body: JSON.stringify(data) });
    } catch (e) {
        console.error('Failed to update UserDO', e);
    }

    // Update Index
    // Only update fields if present in data
    if (data.name || data.email) {
        const updates: string[] = [];
        const args: any[] = [];
        if (data.name !== undefined) {
            updates.push('name = ?');
            args.push(data.name);
        }
        if (data.email !== undefined) {
            updates.push('email = ?');
            args.push(data.email);
        }
        
        if (updates.length > 0) {
            args.push(userId);
            this.sql.exec(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...args);
        }
    }

    return Response.json({ success: true });
  }

  async listAccounts(params: URLSearchParams): Promise<Response> {
    const query = params.get('q');
    let sql = 'SELECT * FROM accounts';
    const args: any[] = [];

    if (query) {
      sql += ' WHERE name LIKE ?';
      args.push(`%${query}%`);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';

    const result = this.sql.exec(sql, ...args);
    const accounts = Array.from(result);
    return Response.json(accounts);
  }

  async getAccount(accountId: string): Promise<Response> {
     try {
         const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
         const [infoRes, billingRes] = await Promise.all([
             stub.fetch('http://do/info'),
             stub.fetch('http://do/billing')
         ]);
         
         const info = infoRes.ok ? await infoRes.json() : {};
         const billing = billingRes.ok ? await billingRes.json() : {};
         
         return Response.json({ ...info, billing });
     } catch (e: any) {
         return new Response(e.message, { status: 500 });
     }
  }

  async registerAccount(request: Request): Promise<Response> {
    const data = (await request.json()) as {
      id: string;
      name: string;
      status?: string;
      plan?: string;
    };
    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO accounts (id, name, status, plan, created_at) VALUES (?, ?, ?, ?, ?)',
      data.id,
      data.name,
      data.status || 'active',
      data.plan || 'free',
      now,
    );

    return Response.json({ success: true });
  }

  async updateAccount(request: Request, accountId: string): Promise<Response> {
    const data = (await request.json()) as any;

    // Update AccountDO
    try {
        const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
        await stub.fetch('http://do/info', { method: 'POST', body: JSON.stringify(data) });
    } catch (e) {
         console.error('Failed to update AccountDO', e);
    }

    // Update Index
    const updates: string[] = [];
    const args: any[] = [];
    
    if (data.name !== undefined) {
        updates.push('name = ?');
        args.push(data.name);
    }
    if (data.status !== undefined) {
        updates.push('status = ?');
        args.push(data.status);
    }
    // Plan update usually via billing, but if forced:
    if (data.plan !== undefined) {
         updates.push('plan = ?');
         args.push(data.plan);
    }

    if (updates.length > 0) {
        args.push(accountId);
        this.sql.exec(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, ...args);
    }

    return Response.json({ success: true });
  }
}