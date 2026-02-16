import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';

export class SystemDO extends DurableObject {
  sql: SqlStorage;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    super(state, env);
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
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/users') {
      if (method === 'GET') return Response.json(await this.listUsers(url.searchParams.get('q') || undefined));
      if (method === 'POST') return Response.json(await this.registerUser(await request.json()));
    } else if (path === '/resolve-credential') {
      return Response.json(await this.resolveCredential(url.searchParams.get('provider')!, url.searchParams.get('subject_id')!));
    } else if (path === '/credentials' && method === 'POST') {
      return Response.json(await this.registerCredential(await request.json()));
    } else if (path.startsWith('/users/')) {
      const parts = path.split('/');
      const userId = parts[2];
      const subPath = parts[3];

      if (userId) {
        if (subPath === 'memberships') {
          return Response.json(await this.getUserMemberships(userId));
        }

        if (method === 'GET') return Response.json(await this.getUser(userId));
        if (method === 'PUT') return Response.json(await this.updateUser(userId, await request.json()));
        if (method === 'DELETE') return Response.json(await this.deleteUser(userId));
      }
    } else if (path === '/accounts') {
      if (method === 'GET') return Response.json(await this.listAccounts(url.searchParams.get('q') || undefined));
      if (method === 'POST') return Response.json(await this.registerAccount(await request.json()));
    } else if (path.startsWith('/accounts/')) {
      const parts = path.split('/');
      const accountId = parts[2];
      const subPath = parts[3];

      if (accountId) {
        if (subPath === 'members') {
          const accountStub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
          if (parts[4]) {
            // /accounts/:id/members/:userId
            return Response.json(await accountStub.removeMember(parts[4]));
          }
          if (method === 'GET') return Response.json(await accountStub.getMembers());
          if (method === 'POST') {
            const { user_id, role } = await request.json() as any;
            return Response.json(await accountStub.addMember(user_id, role));
          }
        }

        if (method === 'GET') return Response.json(await this.getAccount(accountId));
        if (method === 'PUT') return Response.json(await this.updateAccount(accountId, await request.json()));
        if (method === 'DELETE') return Response.json(await this.deleteAccount(accountId));
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

  async listUsers(query?: string) {
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
    return users;
  }

  async resolveCredential(provider: string, subject_id: string) {
    const id = this.env.CREDENTIAL.idFromName(provider);
    const stub = this.env.CREDENTIAL.get(id);
    const data = await stub.get(subject_id);
    
    if (!data) return null;

    return { user_id: data.user_id };
  }

  async registerCredential(data: any) {
    const { provider } = data;

    // Store in provider-level CredentialDO
    const id = this.env.CREDENTIAL.idFromName(provider);
    const stub = this.env.CREDENTIAL.get(id);
    await stub.put(data);

    return { success: true };
  }

  async getUserMemberships(userId: string) {
    const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
    return await userStub.getMemberships();
  }

  async getUser(userId: string) {
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      const profile = await userStub.getProfile();
      return profile;
    } catch (e: any) {
      throw new Error(e.message);
    }
  }

  async registerUser(data: { id: string; name: string; email?: string; provider?: string }) {
    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO users (id, name, email, provider, created_at) VALUES (?, ?, ?, ?, ?)',
      data.id,
      data.name,
      data.email || null,
      data.provider || null,
      now,
    );

    return { success: true };
  }

  async deleteUser(userId: string) {
    // Delete from index
    this.sql.exec('DELETE FROM users WHERE id = ?', userId);

    // Call UserDO to delete its data
    try {
      const stub = this.env.USER.get(this.env.USER.idFromString(userId));
      await stub.delete();
    } catch (e) {
      console.error('Failed to clear UserDO data', e);
    }

    return { success: true };
  }

  async updateUser(userId: string, data: any) {
    // Update UserDO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.updateProfile(data);
    } catch (e) {
      console.error('Failed to update UserDO', e);
    }

    // Update Index
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

    return { success: true };
  }

  async listAccounts(query?: string) {
    let sql = 'SELECT * FROM accounts';
    const args: any[] = [];

    if (query) {
      sql += ' WHERE name LIKE ?';
      args.push(`%${query}%`);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';

    const result = this.sql.exec(sql, ...args);
    return Array.from(result);
  }

  async getAccount(accountId: string) {
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      const info = await stub.getInfo();
      const billing = await stub.getBillingInfo();

      return { ...info, billing };
    } catch (e: any) {
      throw new Error(e.message);
    }
  }

  async registerAccount(data: { id?: string; name: string; status?: string; plan?: string; ownerId?: string }) {
    let accountIdStr = data.id;
    if (!accountIdStr) {
      const id = this.env.ACCOUNT.newUniqueId();
      accountIdStr = id.toString();

      // Initialize AccountDO
      const stub = this.env.ACCOUNT.get(id);
      await stub.updateInfo({
        name: data.name,
      });

      // If owner provided, add them as ADMIN
      if (data.ownerId) {
        await stub.addMember(data.ownerId, 1);
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

    return { success: true, id: accountIdStr };
  }

  async deleteAccount(accountId: string) {
    // Delete from index
    this.sql.exec('DELETE FROM accounts WHERE id = ?', accountId);

    // Call AccountDO to delete its data
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      await stub.delete();
    } catch (e) {
      console.error('Failed to clear AccountDO data', e);
    }

    return { success: true };
  }

  async incrementMemberCount(accountId: string) {
    this.sql.exec('UPDATE accounts SET member_count = member_count + 1 WHERE id = ?', accountId);
  }

  async decrementMemberCount(accountId: string) {
    this.sql.exec('UPDATE accounts SET member_count = member_count - 1 WHERE id = ?', accountId);
  }

  async updateAccount(accountId: string, data: any) {
    // Update AccountDO
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      await stub.updateInfo(data);
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

    return { success: true };
  }
}
