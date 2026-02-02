import { DurableObject } from 'cloudflare:workers';
import { initPlans } from './billing/plansConfig';
import { Plan } from './billing/Plan';
import { MockPaymentEngine } from './billing/PaymentEngine';
import { StartupAPIEnv } from './StartupAPIEnv';

/**
 * A Durable Object representing an Account (Tenant).
 * This class handles account-specific data, settings, and memberships.
 */
export class AccountDO implements DurableObject {
  static ROLE_USER = 0;
  static ROLE_ADMIN = 1;

  state: DurableObjectState;
  env: StartupAPIEnv;
  sql: SqlStorage;
  paymentEngine: MockPaymentEngine;

  constructor(state: DurableObjectState, env: StartupAPIEnv) {
    this.state = state;
    this.env = env;
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
    } else if (path === '/billing' && method === 'GET') {
      return this.getBillingInfo();
    } else if (path === '/billing/subscribe' && method === 'POST') {
      return this.subscribe(request);
    } else if (path === '/billing/cancel' && method === 'POST') {
      return this.cancelSubscription();
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

    // Update Account DO
    this.sql.exec('INSERT OR REPLACE INTO members (user_id, role, joined_at) VALUES (?, ?, ?)', user_id, role, now);

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(user_id));
      await userStub.fetch('http://do/memberships', {
        method: 'POST',
        body: JSON.stringify({
          account_id: this.state.id.toString(),
          role,
          is_current: false, // Default to false when added by Account
        }),
      });
    } catch (e) {
      console.error('Failed to sync membership to UserDO', e);
      // We might want to rollback or retry, but for now we log.
      // In a real system, we'd use a queue or reliable workflow.
    }

    return Response.json({ success: true });
  }

  async removeMember(userId: string): Promise<Response> {
    this.sql.exec('DELETE FROM members WHERE user_id = ?', userId);

    // Sync with User DO
    try {
      const userStub = this.env.USER.get(this.env.USER.idFromString(userId));
      await userStub.fetch('http://do/memberships', {
        method: 'DELETE',
        body: JSON.stringify({
          account_id: this.state.id.toString(),
        }),
      });
    } catch (e) {
      console.error('Failed to sync membership removal to UserDO', e);
    }

    return Response.json({ success: true });
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
    this.state.storage.transactionSync(() => {
        this.sql.exec("INSERT OR REPLACE INTO account_info (key, value) VALUES ('billing', ?)", JSON.stringify(state));
    });
  }

  async getBillingInfo(): Promise<Response> {
    const state = this.getBillingState();
    const plan = Plan.get(state.plan_slug);
    return Response.json({
      state,
      plan_details: plan,
    });
  }

  async subscribe(request: Request): Promise<Response> {
    const { plan_slug, schedule_idx = 0 } = (await request.json()) as { plan_slug: string; schedule_idx?: number };
    const plan = Plan.get(plan_slug);

    if (!plan) {
      return new Response('Plan not found', { status: 400 });
    }

    const currentState = this.getBillingState();

    // Call hook if changing plans (simplification)
    if (currentState.plan_slug !== plan_slug) {
      if (currentState.plan_slug) {
         const oldPlan = Plan.get(currentState.plan_slug);
         if (oldPlan?.account_deactivate_hook) {
             await oldPlan.account_deactivate_hook(this.state.id.toString());
         }
      }
      if (plan.account_activate_hook) {
          await plan.account_activate_hook(this.state.id.toString());
      }
    }

    // Setup recurring payment
    try {
      await this.paymentEngine.setupRecurring(this.state.id.toString(), plan_slug, schedule_idx);
    } catch (e: any) {
      return new Response(`Payment setup failed: ${e.message}`, { status: 500 });
    }

    const newState = {
      ...currentState,
      plan_slug,
      status: 'active',
      schedule_idx,
      next_billing_date: Date.now() + (plan.schedules[schedule_idx]?.charge_period || 30) * 24 * 60 * 60 * 1000
    };

    this.setBillingState(newState);

    return Response.json({ success: true, state: newState });
  }

  async cancelSubscription(): Promise<Response> {
    const currentState = this.getBillingState();
    const currentPlan = Plan.get(currentState.plan_slug);

    if (!currentPlan) {
        return new Response('No active plan', { status: 400 });
    }

    await this.paymentEngine.cancelRecurring(this.state.id.toString());

    // Downgrade logic (immediate or scheduled - simplification: scheduled if downgrade_to_slug exists)
    // For this prototype, we'll mark it as canceled and set the next plan if applicable.
    
    const newState = {
        ...currentState,
        status: 'canceled',
        next_plan_slug: currentPlan.downgrade_to_slug
    };
    
    this.setBillingState(newState);
    
    return Response.json({ success: true, state: newState });
  }
}
