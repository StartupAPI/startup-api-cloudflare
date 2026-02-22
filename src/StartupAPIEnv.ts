export type StartupAPIEnv = {
  ORIGIN_URL: URL;
  USERS_PATH: string;
  AUTH_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  ADMIN_IDS: string;
  SESSION_SECRET: string;
  ENVIRONMENT?: string;
  SYSTEM: DurableObjectNamespace;
  IMAGES: R2Bucket;
} & Env;
