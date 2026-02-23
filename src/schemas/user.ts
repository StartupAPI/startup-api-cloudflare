import { z } from 'zod';

export const UserProfileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  email: z.string().email().nullable().optional(),
  picture: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  verified_email: z.boolean().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SystemUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email().nullable().optional(),
  provider: z.string().nullable().optional(),
  created_at: z.number().optional(),
});

export type SystemUser = z.infer<typeof SystemUserSchema>;
