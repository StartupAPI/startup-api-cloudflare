export type StartupAPIEnv = {
  ORIGIN_URL: URL;
  USERS_PATH: string;
  AUTH_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_SCOPES?: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TWITCH_SCOPES?: string;
  PATREON_CLIENT_ID: string;
  PATREON_CLIENT_SECRET: string;
  PATREON_SCOPES?: string;
  ADMIN_IDS: string;
  SESSION_SECRET: string;
  ENVIRONMENT?: string;
} & Env;
