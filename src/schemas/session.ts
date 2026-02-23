import { z } from 'zod';

export const SessionSchema = z.object({
  id: z.string(),
  created_at: z.number(),
  expires_at: z.number(),
  meta: z.record(z.any()).nullable().optional(),
});

export type Session = z.infer<typeof SessionSchema>;
