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
        member_count INTEGER DEFAULT 0,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS user_credentials (
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        PRIMARY KEY (user_id, provider, subject_id)
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
    } else if (path === '/resolve-credential') {
      return this.resolveCredential(url.searchParams);
    } else if (path === '/credentials' && method === 'POST') {
      return this.registerCredential(request);
    } else if (path.startsWith('/users/')) {
      const parts = path.split('/');
      const userId = parts[2];
      const subPath = parts[3];

      if (userId) {
        if (subPath === 'memberships') {
          const stub = this.env.USER.get(this.env.USER.idFromString(userId));
          return stub.fetch(new Request('http://do/memberships', request));
        }

        if (subPath === 'credentials') {
          if (method === 'GET') return this.listUserCredentials(userId);
          if (method === 'DELETE') return this.deleteUserCredential(request, userId);
        }

        if (method === 'GET') return this.getUser(userId);
        if (method === 'PUT') return this.updateUser(request, userId);
        if (method === 'DELETE') return this.deleteUser(userId);
      }
    } else if (path === '/accounts') {
      if (method === 'GET') return this.listAccounts(url.searchParams);
      if (method === 'POST') return this.registerAccount(request);
    } else if (path.startsWith('/accounts/')) {
      const parts = path.split('/');
      const accountId = parts[2];
      const subPath = parts[3];

      if (accountId) {
        if (subPath === 'members') {
          const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
          if (parts[4]) {
            // /accounts/:id/members/:userId
            return stub.fetch(new Request('http://do/members/' + parts[4], request));
          }
          return stub.fetch(new Request('http://do/members', request));
        }

        if (method === 'GET') return this.getAccount(accountId);
        if (method === 'PUT') return this.updateAccount(request, accountId);
        if (method === 'DELETE') return this.deleteAccount(accountId);
        if (path.endsWith('/increment-members')) {
          await this.incrementMemberCount(accountId);
          return Response.json({ success: true });
        }
        if (path.endsWith('/decrement-members')) {
          await this.decrementMemberCount(accountId);
          return Response.json({ success: true });
        }
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
    const users = Array.from(result).map((u: any) => {
      const adminIds = (this.env.ADMIN_IDS || '').split(',').map((id) => id.trim());
      const isAdmin =
        adminIds.includes(u.id) ||
        (u.email && adminIds.includes(u.email)) ||
        (u.provider && u.id && adminIds.includes(`${u.provider}:${u.id}`));

      return {
        ...u,
        is_admin: isAdmin,
      };
    });
    return Response.json(users);
  }

  async resolveCredential(params: URLSearchParams): Promise<Response> {
    const provider = params.get('provider');
    const subject_id = params.get('subject_id');

    if (!provider || !subject_id) {
      return new Response('Missing provider or subject_id', { status: 400 });
    }

    const id = this.env.CREDENTIAL.idFromName(`${provider}:${subject_id}`);
    const stub = this.env.CREDENTIAL.get(id);
    const res = await stub.fetch('http://do/');
    
    if (!res.ok) {
      return new Response('Not Found', { status: 404 });
    }

    const data = await res.json() as any;
    return Response.json({ user_id: data.user_id });
  }

  async registerCredential(request: Request): Promise<Response> {
    const data = (await request.json()) as any;
    const { provider, subject_id } = data;

    if (!provider || !subject_id) {
      return new Response('Missing required fields', { status: 400 });
    }

    // Store in CredentialDO
    const id = this.env.CREDENTIAL.idFromName(`${provider}:${subject_id}`);
    const stub = this.env.CREDENTIAL.get(id);
    await stub.fetch('http://do/', {
      method: 'PUT',
      body: JSON.stringify(data)
    });

    // Index in SystemDO
    this.sql.exec(
      'INSERT OR REPLACE INTO user_credentials (user_id, provider, subject_id) VALUES (?, ?, ?)',
      data.user_id,
      provider,
      subject_id
    );

    return Response.json({ success: true });
  }

  async listUserCredentials(userId: string): Promise<Response> {
    const result = this.sql.exec('SELECT provider, subject_id FROM user_credentials WHERE user_id = ?', userId);
    const credentials = [];
    for (const row of result) {
      const id = this.env.CREDENTIAL.idFromName(`${row.provider}:${row.subject_id}`);
      const stub = this.env.CREDENTIAL.get(id);
      const res = await stub.fetch(`http://do/`);
      if (res.ok) {
        credentials.push(await res.json());
      }
    }
    return Response.json(credentials);
  }

  async deleteUserCredential(request: Request, userId: string): Promise<Response> {
    const { provider } = (await request.json()) as { provider: string };

    const result = this.sql.exec('SELECT provider, subject_id FROM user_credentials WHERE user_id = ?', userId);
    const userCredentials = Array.from(result) as any[];

    if (userCredentials.length <= 1) {
      return new Response('Cannot delete the last credential', { status: 400 });
    }

    const credToDelete = userCredentials.find(c => c.provider === provider);
    if (credToDelete) {
      const id = this.env.CREDENTIAL.idFromName(`${credToDelete.provider}:${credToDelete.subject_id}`);
      const stub = this.env.CREDENTIAL.get(id);
      await stub.fetch('http://do/', { method: 'DELETE' });

      this.sql.exec('DELETE FROM user_credentials WHERE user_id = ? AND provider = ?', userId, provider);
    }

    return Response.json({ success: true });
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

  async deleteUser(userId: string): Promise<Response> {
    // Delete from index
    this.sql.exec('DELETE FROM users WHERE id = ?', userId);
    this.sql.exec('DELETE FROM user_credentials WHERE user_id = ?', userId);

    // Call UserDO to delete its data
    try {
      const stub = this.env.USER.get(this.env.USER.idFromString(userId));
      await stub.fetch('http://do/delete', { method: 'POST' });
    } catch (e) {
      console.error('Failed to clear UserDO data', e);
    }

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
      const [infoRes, billingRes] = await Promise.all([stub.fetch('http://do/info'), stub.fetch('http://do/billing')]);

      const info = infoRes.ok ? await infoRes.json() : {};
      const billing = billingRes.ok ? await billingRes.json() : {};

      return Response.json({ ...info, billing });
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  }

  async registerAccount(request: Request): Promise<Response> {
    const data = (await request.json()) as {
      id?: string;
      name: string;
      status?: string;
      plan?: string;
      ownerId?: string;
    };

    let accountIdStr = data.id;
    if (!accountIdStr) {
      const id = this.env.ACCOUNT.newUniqueId();
      accountIdStr = id.toString();

      // Initialize AccountDO
      const stub = this.env.ACCOUNT.get(id);
      await stub.fetch('http://do/info', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
        }),
      });

      // If owner provided, add them as ADMIN
      if (data.ownerId) {
        await stub.fetch('http://do/members', {
          method: 'POST',
          body: JSON.stringify({
            user_id: data.ownerId,
            role: 1, // ADMIN
          }),
        });
      }
    }

    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO accounts (id, name, status, plan, member_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      accountIdStr,
      data.name,
      data.status || 'active',
      data.plan || 'free',
      data.ownerId ? 1 : 0,
      now,
    );

    return Response.json({ success: true, id: accountIdStr });
  }

  async deleteAccount(accountId: string): Promise<Response> {
    // Delete from index
    this.sql.exec('DELETE FROM accounts WHERE id = ?', accountId);

    // Call AccountDO to delete its data
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      await stub.fetch('http://do/delete', { method: 'POST' });
    } catch (e) {
      console.error('Failed to clear AccountDO data', e);
    }

    return Response.json({ success: true });
  }

  async incrementMemberCount(accountId: string) {
    this.sql.exec('UPDATE accounts SET member_count = member_count + 1 WHERE id = ?', accountId);
  }

  async decrementMemberCount(accountId: string) {
    this.sql.exec('UPDATE accounts SET member_count = member_count - 1 WHERE id = ?', accountId);
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
