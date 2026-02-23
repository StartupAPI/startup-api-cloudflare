import { z } from 'zod';

export const AccountInfoSchema = z.object({
  id: z.string().optional(),
  name: z.string().nullable().optional(),
  plan: z.string().optional(),
  personal: z.boolean().optional(),
  billing: z.record(z.any()).optional(),
});

export type AccountInfo = z.infer<typeof AccountInfoSchema>;

export const MemberSchema = z.object({
  user_id: z.string(),
  role: z.number(),
  joined_at: z.number().optional(),
  name: z.string().optional(),
  picture: z.string().nullable().optional(),
});

export type Member = z.infer<typeof MemberSchema>;

export const SystemAccountSchema = z.object({
  id: z.string().optional(),
  name: z.string().max(100),
  status: z.string().optional(),
  plan: z.string().optional(),
  member_count: z.number().optional(),
  created_at: z.number().optional(),
  ownerId: z.string().optional(),
});

export type SystemAccount = z.infer<typeof SystemAccountSchema>;

export const SwitchAccountSchema = z.object({
  account_id: z.string(),
});
