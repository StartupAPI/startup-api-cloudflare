import { DurableObject } from 'cloudflare:workers';
import { StartupAPIEnv } from './StartupAPIEnv';
import { SystemUserSchema } from './schemas/user';
import { SystemAccountSchema } from './schemas/account';
import type { SystemUser } from './schemas/user';
import type { SystemAccount } from './schemas/account';

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

  async listUsers(query?: string): Promise<any[]> {
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
        (this.env.ENVIRONMENT === 'test' &&
          adminIds.some((id) => {
            try {
              return u.id === this.env.USER.idFromName(id).toString();
            } catch (_e) {
              return false;
            }
          }));

      return {
        ...u,
        is_admin: isAdmin,
      };
    });
    return users;
  }

  async getUserMemberships(userId: string): Promise<any[]> {
    const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
    return await userStub.getMemberships();
  }

  async getUser(userId: string): Promise<any> {
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      const profile = await userStub.getProfile();
      return profile;
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  async registerUser(data: SystemUser): Promise<{ success: boolean }> {
    const validatedData = SystemUserSchema.parse(data);
    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO users (id, name, email, provider, created_at) VALUES (?, ?, ?, ?, ?)',
      validatedData.id,
      validatedData.name,
      validatedData.email || null,
      validatedData.provider || null,
      now,
    );

    return { success: true };
  }

  async deleteUser(userId: string): Promise<{ success: boolean }> {
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

  async updateUser(userId: string, data: Partial<SystemUser>): Promise<{ success: boolean }> {
    const validatedData = SystemUserSchema.partial().parse(data);
    // Update UserDO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.updateProfile(validatedData);
    } catch (e) {
      console.error('Failed to update UserDO', e);
    }

    // Update Index
    if (validatedData.name || validatedData.email) {
      const updates: string[] = [];
      const args: any[] = [];
      if (validatedData.name !== undefined) {
        updates.push('name = ?');
        args.push(validatedData.name);
      }
      if (validatedData.email !== undefined) {
        updates.push('email = ?');
        args.push(validatedData.email);
      }

      if (updates.length > 0) {
        args.push(userId);
        this.sql.exec(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, ...args);
      }
    }

    return { success: true };
  }

  async listAccounts(query?: string): Promise<any[]> {
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

  async getAccount(accountId: string): Promise<any> {
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      const info = await stub.getInfo();
      const billing = await stub.getBillingInfo();

      return { ...info, billing };
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  async registerAccount(data: SystemAccount): Promise<{ success: boolean; id: string }> {
    const validatedData = SystemAccountSchema.parse(data);
    let accountIdStr = validatedData.id;
    const accountName = validatedData.name;

    if (!accountIdStr) {
      const id = this.env.ACCOUNT.newUniqueId();
      accountIdStr = id.toString();

      // Initialize AccountDO
      const stub = this.env.ACCOUNT.get(id);
      await stub.updateInfo({
        name: accountName,
      });

      // If owner provided, add them as ADMIN
      if (validatedData.ownerId) {
        await stub.addMember(validatedData.ownerId, 1);
      }
    }

    const now = Date.now();

    this.sql.exec(
      'INSERT OR REPLACE INTO accounts (id, name, status, plan, member_count, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      accountIdStr,
      accountName,
      validatedData.status || 'active',
      validatedData.plan || 'free',
      validatedData.ownerId ? 1 : 0,
      now,
    );

    return { success: true, id: accountIdStr };
  }

  async deleteAccount(accountId: string): Promise<{ success: boolean }> {
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

  async updateMemberCount(accountId: string, count: number): Promise<void> {
    this.sql.exec('UPDATE accounts SET member_count = ? WHERE id = ?', count, accountId);
  }

  async updateAccount(accountId: string, data: Partial<SystemAccount>): Promise<{ success: boolean }> {
    const validatedData = SystemAccountSchema.partial().parse(data);

    // Update AccountDO
    try {
      const stub = this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(accountId));
      await stub.updateInfo(validatedData);
    } catch (e) {
      console.error('Failed to update AccountDO', e);
    }

    // Update Index
    const updates: string[] = [];
    const args: any[] = [];

    if (validatedData.name !== undefined) {
      updates.push('name = ?');
      args.push(validatedData.name);
    }
    if (validatedData.status !== undefined) {
      updates.push('status = ?');
      args.push(validatedData.status);
    }
    // Plan update usually via billing, but if forced:
    if (validatedData.plan !== undefined) {
      updates.push('plan = ?');
      args.push(validatedData.plan);
    }

    if (updates.length > 0) {
      args.push(accountId);
      this.sql.exec(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`, ...args);
    }

    return { success: true };
  }
}
