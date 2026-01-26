type StartupAPIConfigOptions = {
  ORIGIN_URL: URL;
  USERS_PATH: string;
  AUTH_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
};

export type StartupAPIEnv = StartupAPIConfigOptions | Env;
