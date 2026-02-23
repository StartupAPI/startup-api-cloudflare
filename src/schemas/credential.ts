import { z } from 'zod';

export const CredentialSchema = z.object({
  provider: z.string(),
  subject_id: z.coerce.string(),
});

export const PublicCredentialSchema = z.object({
  provider: z.string(),
  subject_id: z.coerce.string(),
  email: z.string().optional(),
  created_at: z.number().optional(),
});

export type PublicCredential = z.infer<typeof PublicCredentialSchema>;

export const OAuthCredentialSchema = z.object({
  subject_id: z.coerce.string(),
  user_id: z.coerce.string(),
  access_token: z.string().optional(),
  refresh_token: z.string().optional(),
  expires_at: z.number().optional(),
  scope: z.string().optional(),
  profile_data: z.record(z.any()).optional(),
  created_at: z.number().optional(),
  updated_at: z.number().optional(),
});

export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

export const DeleteCredentialSchema = z.object({
  provider: z.string(),
});
