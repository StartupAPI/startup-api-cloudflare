export type StartupAPIEnv = {
  ORIGIN_URL: URL;
  USERS_PATH: string;
  AUTH_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  PATREON_CLIENT_ID: string;
  PATREON_CLIENT_SECRET: string;
  PATREON_WEBHOOK_SECRET?: string;
  ADMIN_IDS: string;
  SESSION_SECRET: string;
  ENVIRONMENT?: string;
  // atproto has no credentials; this per-deployment flag enables it without touching the factory
  // config (truthy = "true"/"1"/"yes"/"on"). A factory `atproto: { enabled: false }` still overrides it.
  ATPROTO_ENABLED?: string;
} & Env;
