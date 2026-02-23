import { z } from 'zod';

export const MembershipSchema = z.object({
  account_id: z.string(),
  role: z.number().optional(),
  is_current: z.boolean().optional(),
});

export type Membership = z.infer<typeof MembershipSchema>;
