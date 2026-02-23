import { DurableObject } from 'cloudflare:workers';
import { initPlans } from './billing/plansConfig';
import { Plan } from './billing/Plan';
import { MockPaymentEngine } from './billing/PaymentEngine';
import { StartupAPIEnv } from './StartupAPIEnv';
import { AccountInfoSchema, MemberSchema } from './schemas/account';
import { BillingStateSchema } from './schemas/billing';
import type { AccountInfo, Member } from './schemas/account';
import type { BillingState } from './schemas/billing';

/**
 * A Durable Object representing an Account (Tenant).
 * This class handles account-specific data, settings, and memberships.
 */
export class AccountDO extends DurableObject {
  static ROLE_USER = 0;
  static ROLE_ADMIN = 1;

  sql: SqlStorage;
  paymentEngine: MockPaymentEngine;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    super(state, env);
    this.sql = state.storage.sql;
    this.paymentEngine = new MockPaymentEngine();

    // Initialize plans
    initPlans();

    // Initialize database schema
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS account_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT,
        plan TEXT,
        billing TEXT,
        personal INTEGER
      );

      CREATE TABLE IF NOT EXISTS members (
        user_id TEXT PRIMARY KEY,
        role INTEGER,
        joined_at INTEGER
      );
    `);

    // Ensure the single row exists
    this.sql.exec('INSERT OR IGNORE INTO account_info (id, plan) VALUES (1, "free")');
  }

  async getImage(key: string) {
    const r2Key = `account/${this.ctx.id.toString()}/${key}`;
    const object = await this.env.IMAGE_STORAGE.get(r2Key);
    if (!object) return null;
    return {
      value: await object.arrayBuffer(),
      mime_type: object.httpMetadata?.contentType || 'image/jpeg',
    };
  }

  async storeImage(key: string, value: ArrayBuffer, mime_type: string) {
    const r2Key = `account/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.put(r2Key, value, {
      httpMetadata: { contentType: mime_type },
    });
    return { success: true };
  }

  async deleteImage(key: string) {
    const r2Key = `account/${this.ctx.id.toString()}/${key}`;
    await this.env.IMAGE_STORAGE.delete(r2Key);
    return { success: true };
  }

  async getInfo(): Promise<AccountInfo> {
    try {
      const result = this.sql.exec('SELECT * FROM account_info WHERE id = 1');
      const row = result.next().value as any;
      if (!row) return {};

      return AccountInfoSchema.parse({
        name: row.name,
        plan: row.plan,
        personal: row.personal === 1,
        billing: row.billing ? JSON.parse(row.billing) : undefined,
      });
    } catch (_e) {
      return {};
    }
  }

  async updateInfo(data: Record<string, any>) {
    try {
      const validatedData = AccountInfoSchema.partial().parse(data);
      const updates: string[] = [];
      const values: any[] = [];

      if ('name' in validatedData) {
        updates.push('name = ?');
        values.push(typeof validatedData.name === 'string' ? validatedData.name.substring(0, 50) : validatedData.name);
      }
      if ('plan' in validatedData) {
        updates.push('plan = ?');
        values.push(validatedData.plan);
      }
      if ('personal' in validatedData) {
        updates.push('personal = ?');
        values.push(validatedData.personal ? 1 : 0);
      }

      if (updates.length > 0) {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`UPDATE account_info SET ${updates.join(', ')} WHERE id = 1`, ...values);

          // If plan is updated manually (e.g. via Admin API), update billing state too
          if ('plan' in data) {
            const currentState = this.getBillingState();
            if (currentState.plan_slug !== data.plan) {
              const newState: BillingState = {
                ...currentState,
                plan_slug: data.plan,
              };
              this.sql.exec('UPDATE account_info SET billing = ? WHERE id = 1', JSON.stringify(newState));
            }
          }
        });
      }
      return { success: true };
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
  }

  async getMembers(): Promise<Member[]> {
    const result = Array.from(this.sql.exec('SELECT user_id, role, joined_at FROM members'));
    const membersWithNames = await Promise.all(
      result.map(async (m: any) => {
        try {
          const userStub = this.env.USER.get(this.env.USER.idFromString(m.user_id));
          const profile = await userStub.getProfile();
          const image = await userStub.getImage('avatar');

          let picture = profile.picture || null;
          if (image) {
            picture = `/users/api/users/${m.user_id}/avatar`;
          } else {
            picture = null;
          }

          return MemberSchema.parse({
            ...m,
            name: profile.name || 'Unknown User',
            picture: picture,
          });
        } catch (_e) {
          return MemberSchema.parse({ ...m, name: 'Unknown User', picture: null });
        }
      }),
    );
    return membersWithNames;
  }

  async addMember(user_id: string, role: number) {
    const now = Date.now();

    // Update Account DO
    this.sql.exec('INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)', user_id, role, now);

    // Update SystemDO index
    await this.syncMemberCount();

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(user_id));
      await userStub.addMembership(this.ctx.id.toString(), role, false);
    } catch (_e) {
      console.error('Failed to sync membership to UserDO', _e);
    }

    return { success: true };
  }

  async updateMemberRole(userId: string, role: number) {
    this.sql.exec('UPDATE members SET role = ? WHERE user_id = ?', role, userId);

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.addMembership(this.ctx.id.toString(), role, false);
    } catch (_e) {
      console.error('Failed to sync membership role to UserDO', _e);
    }

    return { success: true };
  }

  async removeMember(userId: string) {
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);

    // Update SystemDO index
    await this.syncMemberCount();

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.deleteMembership(this.ctx.id.toString());
    } catch (_e) {
      console.error('Failed to sync membership removal to UserDO', _e);
    }

    return { success: true };
  }

  private async syncMemberCount() {
    try {
      const result = this.sql.exec('SELECT COUNT(*) as count FROM members');
      const row = result.next().value as any;
      const count = row ? row.count : 0;

      const systemStub = this.env.SYSTEM.get(this.env.SYSTEM.idFromName('global'));
      await systemStub.updateMemberCount(this.ctx.id.toString(), count);
    } catch (_e) {
      console.error('Failed to update member count in SystemDO', _e);
    }
  }

  async delete() {
    // Get all members to notify their UserDOs
    const members = Array.from(this.sql.exec('SELECT user_id FROM members'));
    for (const member of members as any[]) {
      try {
        const userStub = this.env.USER.get(this.env.USER.idFromString(member.user_id));
        await userStub.deleteMembership(this.ctx.id.toString());
      } catch (_e) {
        console.error(`Failed to notify UserDO ${member.user_id} of account deletion`, _e);
      }
    }

    // Delete all account images from R2
    const prefix = `account/${this.ctx.id.toString()}/`;
    const listed = await this.env.IMAGE_STORAGE.list({ prefix });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await this.env.IMAGE_STORAGE.delete(keys);
    }

    // Wipe all Durable Object storage
    await this.ctx.storage.deleteAll();

    return { success: true };
  }

  // Billing Implementation

  private getBillingState(): BillingState {
    try {
      const result = this.sql.exec('SELECT billing FROM account_info WHERE id = 1');
      const row = result.next().value as any;
      if (row && row.billing) {
        return BillingStateSchema.parse(JSON.parse(row.billing));
      }
    } catch (_e) {
      // ignore
    }
    return {
      plan_slug: 'free',
      status: 'active',
    };
  }

  private setBillingState(state: BillingState) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('UPDATE account_info SET billing = ?, plan = ? WHERE id = 1', JSON.stringify(state), state.plan_slug);
    });
  }

  async getBillingInfo() {
    const state = this.getBillingState();
    const plan = Plan.get(state.plan_slug);

    // Create a serializable version of the plan
    const planDetails = plan
      ? {
          slug: plan.slug,
          name: plan.name,
          capabilities: plan.capabilities,
          downgrade_to_slug: plan.downgrade_to_slug,
          grace_period: plan.grace_period,
          schedules: plan.schedules.map((s) => ({
            charge_amount: s.charge_amount,
            charge_period: s.charge_period,
            is_default: s.is_default,
          })),
        }
      : null;

    return {
      state,
      plan_details: planDetails,
    };
  }

  async subscribe(plan_slug: string, schedule_idx: number = 0) {
    const plan = Plan.get(plan_slug);

    if (!plan) {
      throw new Error('Plan not found');
    }

    const currentState = this.getBillingState();

    // Call hook if changing plans (simplification)
    if (currentState.plan_slug !== plan_slug) {
      if (currentState.plan_slug) {
        const oldPlan = Plan.get(currentState.plan_slug);
        if (oldPlan?.account_deactivate_hook) {
          await oldPlan.account_deactivate_hook(this.ctx.id.toString());
        }
      }
      if (plan.account_activate_hook) {
        await plan.account_activate_hook(this.ctx.id.toString());
      }
    }

    // Setup recurring payment
    try {
      await this.paymentEngine.setupRecurring(this.ctx.id.toString(), plan_slug, schedule_idx);
    } catch (e) {
      throw new Error(`Payment setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const newState: BillingState = {
      ...currentState,
      plan_slug,
      status: 'active',
      schedule_idx,
      next_billing_date: Date.now() + (plan.schedules[schedule_idx]?.charge_period || 30) * 24 * 60 * 60 * 1000,
    };

    this.setBillingState(newState);

    return { success: true, state: newState };
  }

  async cancelSubscription() {
    const currentState = this.getBillingState();
    const currentPlan = Plan.get(currentState.plan_slug);

    if (!currentPlan) {
      throw new Error('No active plan');
    }

    await this.paymentEngine.cancelRecurring(this.ctx.id.toString());

    // Downgrade logic (immediate or scheduled - simplification: scheduled if downgrade_to_slug exists)
    // For this prototype, we'll mark it as canceled and set the next plan if applicable.

    const newState: BillingState = {
      ...currentState,
      status: 'canceled',
      next_plan_slug: currentPlan.downgrade_to_slug,
    };

    this.setBillingState(newState);

    return { success: true, state: newState };
  }
}
