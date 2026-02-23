import { z } from 'zod';

export const UserProfileSchema = z.object({
  id: z.string().optional(),
  name: z.coerce.string().optional(),
  email: z.string().nullable().optional(),
  picture: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  verified_email: z.coerce.boolean().optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const SystemUserSchema = z.object({
  id: z.string(),
  name: z.coerce.string(),
  email: z.string().nullable().optional(),
  provider: z.string().nullable().optional(),
  created_at: z.number().optional(),
});

export type SystemUser = z.infer<typeof SystemUserSchema>;
