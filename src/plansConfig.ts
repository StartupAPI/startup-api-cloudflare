import { Plan, PlanConfig } from './Plan';

const plans: PlanConfig[] = [
  {
    slug: 'free',
    name: 'Free',
    capabilities: {
      can_access_basic: true,
      can_access_pro: false,
    },
    schedules: [
      { charge_amount: 0, charge_period: 30, is_default: true }
    ]
  },
  {
    slug: 'pro',
    name: 'Pro',
    capabilities: {
      can_access_basic: true,
      can_access_pro: true,
    },
    downgrade_to_slug: 'free',
    grace_period: 7,
    schedules: [
      { charge_amount: 2900, charge_period: 30, is_default: true }, // $29.00 / month
      { charge_amount: 29000, charge_period: 365 } // $290.00 / year
    ]
  }
];

export function initPlans() {
  Plan.init(plans);
}
