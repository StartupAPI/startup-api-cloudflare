import { z } from 'zod';

export const ImpersonateSchema = z
  .object({
    user_id: z.string().optional(),
    userId: z.string().optional(),
  })
  .refine((data) => data.user_id || data.userId, {
    message: 'Either user_id or userId must be provided',
  });
