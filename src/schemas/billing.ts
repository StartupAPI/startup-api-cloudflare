import { z } from 'zod';

export const BillingStateSchema = z.object({
  plan_slug: z.string(),
  status: z.enum(['active', 'canceled', 'past_due', 'unpaid', 'trialing']),
  schedule_idx: z.number().optional(),
  next_billing_date: z.number().optional(),
  next_plan_slug: z.string().optional(),
});

export type BillingState = z.infer<typeof BillingStateSchema>;
