export type StartupAPIEnv = {
  ORIGIN_URL?: URL;
  // Optional service binding to the origin Worker. When set, origin requests go through it instead of
  // the public internet, so the origin can have no public URL at all. ORIGIN_URL becomes optional.
  ORIGIN?: Fetcher;
  // Optional secret sent to the origin as X-StartupAPI-Origin-Secret on every request, so an origin with
  // a public URL can refuse requests that didn't come through this worker. Set it as a Wrangler secret.
  ORIGIN_SECRET?: string;
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
