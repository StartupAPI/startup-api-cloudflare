# Startup API Cloudflare App

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

This application uses the Cloudflare Developer Platform, including Workers and DurableObjects, to implement foundational web application functionality. It acts as a transparent proxy for your application, allowing you to inject custom UI elements and intercept specific paths.

## Features

- **Transparent Proxying:** Forwards requests to your origin application
- **HTML Injection:** Uses `HTMLRewriter` to inject scripts and custom elements (like `<power-strip>`) into your HTML pages
- **Path Interception:** Intercepts requests to a configurable path to serve internal assets

## Installation

Start a new project with the **`npm create startup-api`** scaffolder. It generates a tiny Cloudflare Worker that pulls this framework in as the [`@startup-api/cloudflare`](https://www.npmjs.com/package/@startup-api/cloudflare) npm dependency — so you stay up to date with `npm update` instead of maintaining a fork of this repository.

```bash
npm create startup-api my-app -- --origin https://your-app-origin.com
cd my-app
npm run dev      # local dev at http://localhost:8787
npm run deploy   # deploy to Cloudflare
```

Run `npm create startup-api` with no arguments to be prompted for the project name and origin URL interactively. Useful flags: `--no-install` (skip `npm install`) and `--yes` / `-y` (non-interactive — requires a `name` and `--origin`).

What you get:

- A minimal `src/index.ts` that re-exports the worker plus a `wrangler.jsonc` you control. The framework ships as the `@startup-api/cloudflare` dependency, so your project stays small.
- A `.dev.vars` file with a random `SESSION_SECRET` for local development. For production, set your own with `npx wrangler secret put SESSION_SECRET`.
- Framework updates are just `npm update @startup-api/cloudflare` — no fork to rebase.

Then set the required `ORIGIN_URL` and any OAuth credentials (see [Configuration](#configuration-details) below) and run `npm run deploy`. See [create-startup-api](https://github.com/StartupAPI/create-startup-api) for full details.

### Automated deployments

`npm run deploy` deploys from your machine. To deploy automatically instead, push your scaffolded project to a GitHub repository and use either:

- **Cloudflare Workers GitHub app** — connect the repo to Cloudflare's [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) Git integration and Cloudflare builds and deploys on every push, no CI config to maintain.
- **A GitHub Actions workflow** — run [`cloudflare/wrangler-action`](https://github.com/cloudflare/wrangler-action) on push to deploy with Wrangler. Add a `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) repository secret so the action can authenticate.

Either way, set your production secrets (`SESSION_SECRET`, OAuth credentials) on the Worker in the Cloudflare dashboard or with `npx wrangler secret put` rather than committing them.

> **Working on the framework itself?** See [CONTRIBUTING.md](./CONTRIBUTING.md) for cloning and running this repository locally.

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

| Variable                 | Required | Default   | Description                                                                   |
| :----------------------- | :------- | :-------- | :---------------------------------------------------------------------------- |
| `ORIGIN_URL`             | **Yes**  | N/A       | The base URL of your origin application (e.g., `https://your-app-origin.com`) |
| `USERS_PATH`             | No       | `/users/` | The path used to serve internal assets like `power-strip.js`                  |
| `AUTH_ORIGIN`            | No       | N/A       | Optional base URL for OAuth redirects (overrides request origin)              |
| `GOOGLE_CLIENT_ID`       | No       | N/A       | Google OAuth2 Client ID                                                       |
| `GOOGLE_CLIENT_SECRET`   | No       | N/A       | Google OAuth2 Client Secret                                                   |
| `TWITCH_CLIENT_ID`       | No       | N/A       | Twitch OAuth2 Client ID                                                       |
| `TWITCH_CLIENT_SECRET`   | No       | N/A       | Twitch OAuth2 Client Secret                                                   |
| `PATREON_CLIENT_ID`      | No       | N/A       | Patreon OAuth2 Client ID                                                      |
| `PATREON_CLIENT_SECRET`  | No       | N/A       | Patreon OAuth2 Client Secret                                                  |
| `PATREON_WEBHOOK_SECRET` | No       | N/A       | Secret for verifying Patreon webhook signatures                               |

> AT Protocol (Bluesky) login needs **no environment variables at all** — it is a public OAuth client with no secret, so it is configured entirely through the `createStartupAPI` factory (see [Bluesky / AT Protocol](#bluesky--at-protocol-atproto) below).

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

#### Bluesky / AT Protocol (atproto)

atproto login is decentralized: there is **no central provider to register with and no client secret**. Instead the worker acts as a [public OAuth client](https://atproto.com/specs/oauth) identified by a client-metadata document it serves itself, and it discovers the right authorization server **per user** from their handle or DID — so it works with `bsky.social` and any self-hosted PDS alike, with no Bluesky host hardcoded.

Because it has no secrets, atproto is configured **entirely through the `createStartupAPI` factory** (not env vars). Just like the env-credential providers are enabled by the presence of their credentials, atproto is enabled simply by **including its config key** — an empty object is enough:

```ts
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    atproto: {}, // including the key enables it — no client id/secret needed
    // All fields below are optional:
    // atproto: {
    //   clientName: 'My App',           // shown on the consent screen (default "StartupAPI")
    //   plcUrl: 'https://plc.directory', // override the PLC directory for did:plc
    //   dohUrl: 'https://cloudflare-dns.com/dns-query', // override the DoH resolver
    //   scopes: 'transition:generic',    // extra scopes on top of the base `atproto`
    //   enabled: false,                  // explicit opt-out (e.g. for dynamically-built config)
    // },
  },
});

export default api.default;
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
```

1. Include `atproto: {}` in the factory `providers` config (no client id/secret needed). Pass `enabled: false` to opt out explicitly.
2. Deploy over **HTTPS** with a stable hostname. The worker automatically serves its client metadata at `https://<your-worker-url>/users/auth/atproto/client-metadata.json` (this URL is the OAuth `client_id`) and registers the redirect URI `https://<your-worker-url>/users/auth/atproto/callback`.
3. That's it. When a visitor clicks **Continue with Bluesky**, they're asked for their handle (e.g. `alice.bsky.social`) or DID; the worker then resolves it through the full atproto discovery chain and redirects them to _their own_ server to sign in:

   ```
   handle ─▶ DID            (HTTPS .well-known/atproto-did, then DNS _atproto.<handle> via DoH)
   DID    ─▶ DID document   (did:plc via the PLC directory, did:web via the domain)
   DID doc─▶ PDS endpoint    (the #atproto_pds service)
   PDS    ─▶ auth server     (.well-known/oauth-protected-resource → oauth-authorization-server)
   ```

The flow uses PKCE, DPoP-bound (sender-constrained) tokens, and Pushed Authorization Requests (PAR) as required by the atproto OAuth profile. The PLC directory and DNS-over-HTTPS resolver are generic infrastructure and can be overridden via the `plcUrl` / `dohUrl` factory options.

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
- **Prefer an explicit closing tag.** `<power-strip></power-strip>` and `<power-strip/>` are both detected, but per the HTML spec `<power-strip/>` is _not_ truly self-closing — the browser treats it as an open tag and nests the following content inside it. Use a closing tag (or place the element last in its container) to avoid surprises.
- **Script-only opt-out.** Use `<power-strip hidden>` to load `power-strip.js` (and its JS API) without rendering a visible strip.

## Access policy & provider entitlements

StartupAPI can gate access to paths and forward the visitor's login/entitlement status to your origin so it can render gated UI. This is **provider-agnostic infrastructure**; only Patreon currently implements perk-level (benefit/tier) checks — Google and Twitch participate at the login levels only.

### Path-based access policy

Configure an ordered list of rules (first match wins) mapping a path pattern to a requirement, plus a `default` for unmatched paths. Requirement modes:

- **`bypass`** — raw pass-through: no credential check, no identity resolution, no headers, no power-strip injection.
- **`public`** — anyone; the session is resolved and identity/entitlement headers are forwarded when present.
- **`authenticated`** — any logged-in user.
- **`entitlement`** — a provider condition: Patreon `active_patron`, a specific `benefit` (perk) ID, or a `tier` ID.

Patterns are exact (`/special`), prefix (`/app/*`), or `/` (homepage only). Each rule's `on_unauthorized` is `login` (redirect to sign in), `forbidden` (403), `upgrade` (redirect to `upgrade_url`, e.g. a Patreon join page), or `gate` (serve an explainer page **in place**, with no redirect — see below). When no policy is configured at all, every path is treated as `public` (backward compatible).

#### Serving a gate page in place (`on_unauthorized: 'gate'`)

Instead of redirecting, a denied request can serve an explainer page **at the requested URL** (no redirect, status `200` by default). The page shown depends on login state, so anonymous and logged-in-but-unentitled visitors can see different copy:

- **`anonymous`** (required) — shown to visitors who are **not** logged in (e.g. a "become a patron + log in" page).
- **`unentitled`** (optional) — shown to logged-in visitors who fail the requirement (e.g. a "pledge/upgrade" page). Falls back to `anonymous` when omitted.
- **`status`** (optional) — HTTP status for the served page; defaults to `200` to preserve typical explainer-page UX (set `403` if you prefer).

Each variant is a `PageSource` whose body comes from **either** the `ASSETS` binding **or** a path proxied from `ORIGIN_URL` — exactly one of:

- **`{ asset: '/early-access' }`** — a local file from `ASSETS` (resolved like other assets, `/early-access` → `early-access.html`).
- **`{ origin: '/early-access' }`** — a path proxied from `ORIGIN_URL`. The path must be reachable directly on the origin (the raw site, not behind this worker).

The gate config is set per rule via `gate`, or on the policy default via `default_gate`. The served gate page is produced inside the deny path, so it is not re-subjected to the access policy and no power-strip is injected — the page is expected to carry its own login CTA. Because nothing redirects, there is no loop risk.

```ts
const accessPolicy = {
  default: { mode: 'entitlement', provider: 'patreon', condition: { type: 'benefit', benefit_id: '<BENEFIT_ID>' } },
  default_on_unauthorized: 'gate',
  default_gate: {
    anonymous: { origin: '/early-access' }, // or { asset: '/early-access' }
    unentitled: { origin: '/pledge-needed' }, // or { asset: '/pledge-needed' }
    // status: 403, // optional; defaults to 200
  },
};
```

Admin users (those listed in `ADMIN_IDS`) bypass every `authenticated`/`entitlement` requirement and can reach any gated path. Their identity is still resolved and the usual identity/entitlement headers are forwarded to the origin — only the gate itself is skipped. (`bypass` paths remain a raw pass-through for everyone, with no identity resolution.)

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
  accessPolicy: {
    rules: [
      /* ... */
    ],
    default: { mode: 'public' },
  },
});

export default api.default; // includes scheduled() because cron is enabled
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
```

(Remember to add `triggers.crons` to your wrangler config when enabling cron.)

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to clone, run, test, and submit changes to the framework.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
