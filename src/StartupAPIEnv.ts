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
  /** Enable AT Protocol (Bluesky) login. atproto is a public OAuth client (no secret), so it is gated
   *  by this flag rather than by credentials. Truthy values: "true", "1", "yes", "on". */
  ATPROTO_ENABLED?: string;
  /** Display name advertised in the atproto client-metadata document. Defaults to "StartupAPI". */
  ATPROTO_CLIENT_NAME?: string;
  /** Override the PLC directory used to resolve did:plc identities. Defaults to https://plc.directory. */
  ATPROTO_PLC_URL?: string;
  /** Override the DNS-over-HTTPS resolver used for the `_atproto.<handle>` TXT fallback. */
  ATPROTO_DOH_URL?: string;
  ADMIN_IDS: string;
  SESSION_SECRET: string;
  ENVIRONMENT?: string;
} & Env;
