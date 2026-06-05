# Startup API Cloudflare App

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

This application uses the Cloudflare Developer Platform, including Workers and DurableObjects, to implement foundational web application functionality. It acts as a transparent proxy for your application, allowing you to inject custom UI elements and intercept specific paths.

## Features

- **Transparent Proxying:** Forwards requests to your origin application
- **HTML Injection:** Uses `HTMLRewriter` to inject scripts and custom elements (like `<power-strip>`) into your HTML pages
- **Path Interception:** Intercepts requests to a configurable path to serve internal assets

## Installation

### Option 1: Cloudflare Workers GitHub Integration (Recommended)

This is the easiest way to deploy and keep your worker up to date.

1. **Fork this repository** to your account
2. Go to your [Cloudflare Dashboard's Workers & pages > Create Application](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create)
3. Click **Continue with GitHub**
4. Select your forked `startup-api-cloudflare` repository
5. Pick the name for your site's worker (e.g. you might have multiple)
6. Deploy the Worker
7. In the **Settings** tab of your Worker, go to **Variables** and add the required `ORIGIN_URL` (see [Configuration](#configuration-details) below)

### Option 2: Manual Installation (CLI)

Use this option if you want to deploy from your local machine.

1. **Clone and Install**
   ```bash
   git clone https://github.com/StartupAPI/startup-api-cloudflare.git
   cd startup-api-cloudflare
   npm install
   ```
2. **Configure Environment Variables**

   Update `wrangler.jsonc` or use dashboard **Settings** tab of your Worker, go to **Variables** and add the required `ORIGIN_URL` (see [Configuration](#configuration-details) below)

3. **Deploy**
   ```bash
   npm run deploy
   ```

## Configuration Details

### How to set environment variables

- **Using Cloudflare Dashboard (Recommended):**
  1. Go to **Workers & Pages**
  2. Select your worker
  3. Navigate to **Settings** > **Variables**
  4. Click **Add variable** under **Environment Variables**
  5. Add `ORIGIN_URL` and any optional variables
  6. Click **Save and deploy**

- **Using `wrangler.jsonc`:**
  Add the variables to the `"vars"` object in your configuration file. See [Cloudflare documentation](https://developers.cloudflare.com/workers/wrangler/configuration/#environment-variables) for more details.

| Variable               | Required | Default   | Description                                                                   |
| :--------------------- | :------- | :-------- | :---------------------------------------------------------------------------- |
| `ORIGIN_URL`           | **Yes**  | N/A       | The base URL of your origin application (e.g., `https://your-app-origin.com`) |
| `USERS_PATH`           | No       | `/users/` | The path used to serve internal assets like `power-strip.js`                  |
| `AUTH_ORIGIN`          | No       | N/A       | Optional base URL for OAuth redirects (overrides request origin)              |
| `GOOGLE_CLIENT_ID`     | No       | N/A       | Google OAuth2 Client ID                                                       |
| `GOOGLE_CLIENT_SECRET` | No       | N/A       | Google OAuth2 Client Secret                                                   |
| `TWITCH_CLIENT_ID`     | No       | N/A       | Twitch OAuth2 Client ID                                                       |
| `TWITCH_CLIENT_SECRET` | No       | N/A       | Twitch OAuth2 Client Secret                                                   |
| `PATREON_CLIENT_ID`    | No       | N/A       | Patreon OAuth2 Client ID                                                      |
| `PATREON_CLIENT_SECRET`| No       | N/A       | Patreon OAuth2 Client Secret                                                  |
| `PATREON_WEBHOOK_SECRET`| No      | N/A       | Secret for verifying Patreon webhook signatures                              |

> Environment variables hold only credentials/secrets (OAuth client IDs and all secrets) plus the per‑deployment values `ORIGIN_URL`, `AUTH_ORIGIN`, `USERS_PATH`, `ADMIN_IDS`, and `ENVIRONMENT`. **All other configuration — OAuth scopes, Patreon campaign id, the access policy, entitlement freshness — is passed to the `createStartupAPI` factory** (see [Access policy & provider entitlements](#access-policy--provider-entitlements)).

### Setting up OAuth

#### Google

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth client ID**
5. Select **Web application** as the application type
6. Add your authorized redirect URI: `https://<your-worker-url>/users/auth/google/callback`
7. Copy the **Client ID** and **Client Secret** and add them to your Worker's environment variables

#### Twitch

1. Go to the [Twitch Developer Console](https://dev.twitch.tv/console)
2. Register a new application
3. Add your authorized redirect URI: `https://<your-worker-url>/users/auth/twitch/callback`
4. Select **Website** as the category
5. Copy the **Client ID** and generate a **Client Secret** to add them to your Worker's environment variables

#### Patreon

1. Go to the [Patreon Developer Portal](https://www.patreon.com/portal/registration/register-clients)
2. Click **Create Client** and fill in your app details
3. Add your authorized redirect URI: `https://<your-worker-url>/users/auth/patreon/callback`
4. Copy the **Client ID** and **Client Secret** and add them to your Worker's environment variables

#### Requesting additional scopes

Each provider requests the minimal scopes needed to sign a user in and read their basic profile. To request more (for example, to read a user's Patreon memberships), set the provider's `scopes` in the factory config (a string or array). The extra scopes are merged with the required base scopes:

```ts
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    // Adds `identity.memberships` on top of the base `identity identity[email]`
    patreon: { scopes: 'identity.memberships' },
  },
});
```

### Example `wrangler.jsonc` snippet:

```json
{
  "vars": {
    "ORIGIN_URL": "https://your-app-origin.com"
  }
}
```

## How It Works

1. **Request Interception:** The worker receives all incoming requests
2. **Path Mapping:** If the request path starts with `USERS_PATH`, the worker serves assets directly from the `public/users/` directory
3. **Proxying:** All other requests are proxied to the configured `ORIGIN_URL`
4. **Injection:** For `text/html` responses, the worker injects a `<script>` tag and a `<power-strip>` custom element before serving the content to the user

### Customizing the power strip

By default the worker injects its own `<power-strip>` pinned to the top-right corner of the page. If that overlaps your own menu or you simply want it somewhere else, **place a `<power-strip>` element in your own HTML**. When the worker sees one, it injects only `power-strip.js` (which defines the custom element) and leaves your element exactly where you put it — so you control placement and styling:

```html
<nav>
  <!-- ...your links... -->
  <power-strip></power-strip>
</nav>
```

- **`providers` is optional.** If you omit it, the worker fills in the active providers for you (e.g. `providers="google,twitch,patreon"`). Set it yourself to override which login buttons appear.
- **Prefer an explicit closing tag.** `<power-strip></power-strip>` and `<power-strip/>` are both detected, but per the HTML spec `<power-strip/>` is *not* truly self-closing — the browser treats it as an open tag and nests the following content inside it. Use a closing tag (or place the element last in its container) to avoid surprises.
- **Script-only opt-out.** Use `<power-strip hidden>` to load `power-strip.js` (and its JS API) without rendering a visible strip.

## Access policy & provider entitlements

StartupAPI can gate access to paths and forward the visitor's login/entitlement status to your origin so it can render gated UI. This is **provider-agnostic infrastructure**; only Patreon currently implements perk-level (benefit/tier) checks — Google and Twitch participate at the login levels only.

### Path-based access policy

Configure an ordered list of rules (first match wins) mapping a path pattern to a requirement, plus a `default` for unmatched paths. Requirement modes:

- **`bypass`** — raw pass-through: no credential check, no identity resolution, no headers, no power-strip injection.
- **`public`** — anyone; the session is resolved and identity/entitlement headers are forwarded when present.
- **`authenticated`** — any logged-in user.
- **`entitlement`** — a provider condition: Patreon `active_patron`, a specific `benefit` (perk) ID, or a `tier` ID.

Patterns are exact (`/special`), prefix (`/app/*`), or `/` (homepage only). Each rule's `on_unauthorized` is `login` (redirect to sign in), `forbidden` (403), or `upgrade` (redirect to `upgrade_url`, e.g. a Patreon join page). When no policy is configured at all, every path is treated as `public` (backward compatible).

The policy is passed to the factory as `accessPolicy` (see below). Example:

```ts
const accessPolicy = {
  rules: [
    { pattern: '/', requirement: { mode: 'public' } },
    {
      pattern: '/special',
      requirement: { mode: 'entitlement', provider: 'patreon', condition: { type: 'benefit', benefit_id: '<BENEFIT_ID>' } },
      on_unauthorized: 'upgrade',
      upgrade_url: 'https://www.patreon.com/yourpage',
    },
  ],
  default: { mode: 'entitlement', provider: 'patreon', condition: { type: 'active_patron' } },
};
```

### Headers forwarded to the origin

For non-`bypass` paths the worker forwards `X-StartupAPI-Authenticated`, `X-StartupAPI-Login-Provider`, a compact `X-StartupAPI-Entitlements` JSON, and (for Patreon) `X-StartupAPI-Patreon-Active` / `-Tiers` / `-Benefits` alongside the existing `X-StartupAPI-User-Id` / `-Account-Id`.

### Keeping entitlements fresh

Entitlements are fetched once at login. Each provider can additionally opt into freshness mechanisms in its factory config (all off by default — if none are enabled, entitlements are only checked at login):

- **TTL** — lazily re-check on the request path when older than the TTL (`freshness.ttl: { ms }`, default 15 min), using the OAuth refresh token.
- **Cron** — a scheduled re-sync of all of a provider's credentials (`freshness.cron: { schedule }`). The `scheduled()` handler is only present when at least one provider enables cron; you must also add a matching `triggers.crons` to your wrangler config.
- **Webhook** (Patreon only) — set `freshness.webhook: true`, provide `PATREON_WEBHOOK_SECRET` (a secret, in env), and point a Patreon webhook at `<your-worker-url>/users/webhooks/patreon` (signature verified with HMAC-MD5).

Set `providers.patreon.campaignId` to disambiguate when a user belongs to multiple campaigns.

### Configuring via the factory

Environment variables hold only credentials/secrets and the per-deployment values (`ORIGIN_URL`, `AUTH_ORIGIN`, `USERS_PATH`, `ADMIN_IDS`, `ENVIRONMENT`). Everything else — provider scopes, Patreon campaign id, the access policy, and entitlement freshness — is passed to `createStartupAPI(config)`. The plain re-export still works with defaults:

```ts
// Defaults — unchanged:
export { default, UserDO, AccountDO, SystemDO, CredentialDO } from '@startup-api/cloudflare';
```

```ts
// Custom configuration:
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    patreon: {
      scopes: 'identity.memberships',
      campaignId: '<CAMPAIGN_ID>',
      freshness: { ttl: true, cron: { schedule: '0 */6 * * *' }, webhook: true },
    },
  },
  accessPolicy: { rules: [/* ... */], default: { mode: 'public' } },
});

export default api.default; // includes scheduled() because cron is enabled
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
```

(Remember to add `triggers.crons` to your wrangler config when enabling cron.)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
