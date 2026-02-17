import { DurableObject } from 'cloudflare:workers';
import { initPlans } from './billing/plansConfig';
import { Plan } from './billing/Plan';
import { MockPaymentEngine } from './billing/PaymentEngine';
import { StartupAPIEnv } from './StartupAPIEnv';

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

  async getInfo() {
    const result = this.sql.exec('SELECT key, value FROM account_info');
    const info: Record<string, any> = {};
    for (const row of result) {
      // @ts-ignore
      info[row.key] = JSON.parse(row.value as string);
    }
    return info;
  }

  async updateInfo(data: Record<string, any>) {
    try {
      this.ctx.storage.transactionSync(() => {
        for (const [key, value] of Object.entries(data)) {
          let valToStore = value;
          if (key === 'name' && typeof value === 'string') {
            valToStore = value.substring(0, 50);
          }
          this.sql.exec('INSERT OR REPLACE INTO account_info (key, value) VALUES (?, ?)', key, JSON.stringify(valToStore));
        }
      });
      return { success: true };
    } catch (e: any) {
      throw new Error(e.message);
    }
  }

  async getMembers() {
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
          }

          return {
            ...m,
            name: profile.name || 'Unknown User',
            picture: picture,
          };
        } catch (e) {
          return { ...m, name: 'Unknown User', picture: null };
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
    try {
      const systemStub = this.env.SYSTEM.get(this.env.SYSTEM.idFromName('global'));
      await systemStub.incrementMemberCount(this.ctx.id.toString());
    } catch (e) {
      console.error('Failed to update member count in SystemDO', e);
    }

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(user_id));
      await userStub.addMembership(this.ctx.id.toString(), role, false);
    } catch (e) {
      console.error('Failed to sync membership to UserDO', e);
    }

    return { success: true };
  }

  async removeMember(userId: string) {
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);

    // Update SystemDO index
    try {
      const systemStub = this.env.SYSTEM.get(this.env.SYSTEM.idFromName('global'));
      await systemStub.decrementMemberCount(this.ctx.id.toString());
    } catch (e) {
      console.error('Failed to update member count in SystemDO', e);
    }

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.deleteMembership(this.ctx.id.toString());
    } catch (e) {
      console.error('Failed to sync membership removal to UserDO', e);
    }

    return { success: true };
  }

  async delete() {
    // Get all members to notify their UserDOs
    const members = Array.from(this.sql.exec('SELECT user_id FROM members'));
    for (const member of members as any[]) {
      try {
        const userStub = this.env.USER.get(this.env.USER.idFromString(member.user_id));
        await userStub.deleteMembership(this.ctx.id.toString());
      } catch (e) {
        console.error(`Failed to notify UserDO ${member.user_id} of account deletion`, e);
      }
    }

    this.sql.exec('DELETE FROM account_info');
    this.sql.exec('DELETE FROM members');
    return { success: true };
  }

  // Billing Implementation

  private getBillingState(): any {
    const result = this.sql.exec("SELECT value FROM account_info WHERE key = 'billing'");
    for (const row of result) {
      // @ts-ignore
      return JSON.parse(row.value as string);
    }
    return {
      plan_slug: 'free',
      status: 'active',
    };
  }

  private setBillingState(state: any) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("INSERT OR REPLACE INTO account_info (key, value) VALUES ('billing', ?)", JSON.stringify(state));
    });
  }

  async getBillingInfo() {
    const state = this.getBillingState();
    const plan = Plan.get(state.plan_slug);
    
    // Create a serializable version of the plan
    const planDetails = plan ? {
      slug: plan.slug,
      name: plan.name,
      capabilities: plan.capabilities,
      downgrade_to_slug: plan.downgrade_to_slug,
      grace_period: plan.grace_period,
      schedules: plan.schedules.map(s => ({
        charge_amount: s.charge_amount,
        charge_period: s.charge_period,
        is_default: s.is_default
      }))
    } : null;

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
    } catch (e: any) {
      throw new Error(`Payment setup failed: ${e.message}`);
    }

    const newState = {
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

    const newState = {
      ...currentState,
      status: 'canceled',
      next_plan_slug: currentPlan.downgrade_to_slug,
    };

    this.setBillingState(newState);

    return { success: true, state: newState };
  }
}
