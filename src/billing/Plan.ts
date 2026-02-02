export interface PaymentScheduleConfig {
  charge_amount: number;
  charge_period: number; // in days
  is_default?: boolean;
}

export class PaymentSchedule {
  charge_amount: number;
  charge_period: number;
  is_default: boolean;

  constructor(config: PaymentScheduleConfig) {
    this.charge_amount = config.charge_amount;
    this.charge_period = config.charge_period;
    this.is_default = config.is_default || false;
  }
}

export interface PlanConfig {
  slug: string;
  name: string;
  capabilities?: Record<string, boolean>;
  downgrade_to_slug?: string;
  grace_period?: number;
  schedules?: PaymentScheduleConfig[];
  account_activate_hook?: (accountId: string) => Promise<void>;
  account_deactivate_hook?: (accountId: string) => Promise<void>;
}

export class Plan {
  slug: string;
  name: string;
  capabilities: Record<string, boolean>;
  downgrade_to_slug?: string;
  grace_period: number;
  schedules: PaymentSchedule[];
  account_activate_hook?: (accountId: string) => Promise<void>;
  account_deactivate_hook?: (accountId: string) => Promise<void>;

  constructor(config: PlanConfig) {
    this.slug = config.slug;
    this.name = config.name;
    this.capabilities = config.capabilities || {};
    this.downgrade_to_slug = config.downgrade_to_slug;
    this.grace_period = config.grace_period || 0;
    this.schedules = (config.schedules || []).map((s) => new PaymentSchedule(s));
    this.account_activate_hook = config.account_activate_hook;
    this.account_deactivate_hook = config.account_deactivate_hook;
  }

  // Registry of plans
  private static plans: Map<string, Plan> = new Map();

  static init(plans: PlanConfig[]) {
    Plan.plans.clear();
    for (const p of plans) {
      Plan.plans.set(p.slug, new Plan(p));
    }
  }

  static get(slug: string): Plan | undefined {
    return Plan.plans.get(slug);
  }

  static getAll(): Plan[] {
    return Array.from(Plan.plans.values());
  }

  getDefaultSchedule(): PaymentSchedule | undefined {
    return this.schedules.find((s) => s.is_default) || this.schedules[0];
  }
}
