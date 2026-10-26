# Startup API Cloudflare App

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

This application uses the Cloudflare Developer Platform, including Workers and DurableObjects, to implement foundational web application functionality. It acts as a transparent proxy for your application, allowing you to inject custom UI elements and intercept specific paths.

## Features

- **Transparent Proxying:** Forwards requests to your origin application
- **HTML Injection:** Uses `HTMLRewriter` to inject scripts and custom elements (like `<power-strip>`) into your HTML pages, and, when you opt in, the visitor's feature flags
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
| `ATPROTO_ENABLED`        | No       | N/A       | Set truthy (`true`/`1`/`yes`/`on`) to enable AT Protocol (Atmosphere) login   |

> AT Protocol (Atmosphere) login needs **no client secret** — it is a public OAuth client. Enable it either by setting `ATPROTO_ENABLED` truthy (a per-deployment switch) **or** through the `createStartupAPI` factory (see [AT Protocol / Atmosphere](#at-protocol--atmosphere-atproto) below). A factory `atproto: { enabled: false }` overrides the env flag, so a deployment can force it off.

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

#### AT Protocol / Atmosphere (atproto)

atproto login is decentralized: there is **no central provider to register with and no client secret**. Instead the worker acts as a [public OAuth client](https://atproto.com/specs/oauth) identified by a client-metadata document it serves itself, and it discovers the right authorization server **per user** from their handle or DID — so it works with `bsky.social` and any self-hosted PDS alike, with no provider host hardcoded.

Because it has no secrets, atproto is enabled in one of two ways:

- **Env flag (no code):** set `ATPROTO_ENABLED` truthy (`true`/`1`/`yes`/`on`) — handy for toggling it per deployment (e.g. on in prod, off in preview) without touching code. This uses the default settings.
- **Factory config (for customization):** include its config key in `createStartupAPI` — an empty object is enough, and the optional fields below let you set the client name, resolvers, or scopes.

A factory `atproto: { enabled: false }` is an explicit opt-out that **overrides** the env flag, so a deployment can force the provider off.

```ts
import { createStartupAPI } from '@startup-api/cloudflare';

const api = createStartupAPI({
  providers: {
    atproto: {}, // including the key enables it — no client id/secret needed
    // All fields below are optional:
    // atproto: {
    //   clientName: 'My App',           // advertised in the client-metadata document (default "StartupAPI")
    //   plcUrl: 'https://plc.directory', // override the PLC directory for did:plc
    //   dohUrl: 'https://cloudflare-dns.com/dns-query', // override the DoH resolver
    //   scopes: 'account:email',         // extra permissions on top of the base `atproto` (this one adds the account email)
    //   useRootOAuthClientMetadata: false, // keep the client-metadata document under USERS_PATH (default: true, served at /oauth-client-metadata.json)
    //   customOAuthClientMetadataURL: '/oauth-client-metadata.json', // use your own self-hosted document as client_id (requires useRootOAuthClientMetadata: false)
    //   enabled: false,                  // explicit opt-out (e.g. for dynamically-built config)
    // },
  },
});

export default api.default;
export const { UserDO, AccountDO, SystemDO, CredentialDO } = api;
```

1. Enable it — set `ATPROTO_ENABLED` truthy, or include `atproto: {}` in the factory `providers` config (no client id/secret needed either way). A factory `enabled: false` forces it off.
2. Deploy over **HTTPS** with a stable hostname. The worker automatically serves its client metadata at `https://<your-worker-url>/oauth-client-metadata.json` (this URL is the OAuth `client_id`) and registers the redirect URI `https://<your-worker-url>/users/auth/atproto/callback`. See [Where the client-metadata document lives](#where-the-client-metadata-document-lives) if you'd rather not expose a root-level path.
3. That's it. When a visitor clicks **Login with your Atmosphere account**, they're asked for their handle (e.g. `alice.bsky.social`) or DID; the worker then resolves it through the full atproto discovery chain and redirects them to _their own_ server to sign in:

   ```
   handle ─▶ DID            (HTTPS .well-known/atproto-did, then DNS _atproto.<handle> via DoH)
   DID    ─▶ DID document   (did:plc via the PLC directory, did:web via the domain)
   DID doc─▶ PDS endpoint    (the #atproto_pds service)
   PDS    ─▶ auth server     (.well-known/oauth-protected-resource → oauth-authorization-server)
   ```

The flow uses PKCE, DPoP-bound (sender-constrained) tokens, and Pushed Authorization Requests (PAR) as required by the atproto OAuth profile. The PLC directory and DNS-over-HTTPS resolver are generic infrastructure and can be overridden via the `plcUrl` / `dohUrl` factory options.

**Local development.** On `http://localhost`, `127.0.0.1` or `[::1]` no authorization server can fetch the client-metadata document, so the worker uses the atproto [localhost client](https://atproto.com/specs/oauth#localhost-client-development) mode instead: the `client_id` is `http://localhost` with the redirect URI and scope in its query string, and nothing has to be served or registered. The spec requires an IP address in the redirect URI, so a login started on `http://localhost:8787` moves to `http://127.0.0.1:8787` and the session cookie is set there; open the site at `127.0.0.1` to stay logged in. The atproto spec defines this mode for development only.

##### Where the client-metadata document lives

The [atproto OAuth spec](https://atproto.com/specs/oauth) lets the client-metadata document live at any `https://` URL, but `/oauth-client-metadata.json` at the domain root is the recognized convention: the reference PDS consent screen shows **just your hostname** (`example.com`) for a `client_id` at that path, and the **full metadata URL** for any other path. That is why StartupAPI serves it at the root by default — the only route it claims outside `USERS_PATH`. Three modes:

| Mode                             | Config                                                                                                        | Document served by StartupAPI at                            | `client_id`                                              |
| :------------------------------- | :------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------- | :------------------------------------------------------- |
| Root (default)                   | `atproto: {}`                                                                                                 | `/oauth-client-metadata.json`                               | `https://<host>/oauth-client-metadata.json`              |
| Under `USERS_PATH`               | `atproto: { useRootOAuthClientMetadata: false }`                                                              | `/users/auth/atproto/client-metadata.json`                  | `https://<host>/users/auth/atproto/client-metadata.json` |
| Self-hosted (you serve the file) | `atproto: { useRootOAuthClientMetadata: false, customOAuthClientMetadataURL: '/oauth-client-metadata.json' }` | `/users/auth/atproto/client-metadata.json` (reference copy) | your URL (root-relative, or absolute `https://`)         |

In self-hosted mode StartupAPI does not claim the root path; copy the reference document it serves under `USERS_PATH` to your URL verbatim (it already carries your `client_id`, `redirect_uris` and `scope`) and keep them in sync when you change scopes. Setting `customOAuthClientMetadataURL` without `useRootOAuthClientMetadata: false` is a configuration error.

> **What the consent screen shows.** Authorization servers deliberately do **not** display `client_name` or a logo for clients they don't know — those fields are unverified and could impersonate another app — so Bluesky-hosted PDSes show your hostname only. A self-hosted PDS can opt in to showing your name by allowlisting your `client_id` in its `PDS_OAUTH_TRUSTED_CLIENTS` setting.
>
> **Changing the `client_id`** (switching modes, or upgrading from a version that served the document under `USERS_PATH`) invalidates existing atproto authorizations; users simply log in again.

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

**atproto and email.** The base `atproto` scope carries no email — accounts are identified by their DID. Add the [`account:email` permission](https://atproto.com/specs/permission) to also read the account email (and its verification status) from the user's PDS at login, via an authenticated `com.atproto.server.getSession` call:

```ts
atproto: { scopes: 'account:email' },
```

The consent screen then additionally asks for email access, and the email is stored on the user's profile and credential like for the other providers. Without the scope — or if the PDS declines to share it — login still works and the email is simply absent.

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

### Compact account control for your own header

For apps with their own header or top bar, `variant="compact"` turns the power strip into a single account control sized for it: a **"Log in" pill** when signed out (a person icon and the words), and a **round avatar** when signed in that opens an **account menu** — name and email, account switching (when the user has more than one account), Account settings, Profile, Admin and Stop impersonating (when they apply), and Log out.

```html
<header>
  …
  <power-strip variant="compact"></power-strip>
</header>
```

- **One provider, one click.** With a single provider, "Log in" links straight to it; with several it opens the provider dialog. Both log-in and log-out return to the page they were clicked on.
- **Right on the first paint.** The worker writes `auth-state="signed-in|signed-out"` onto the element from the request's session, and the component remembers the last profile it showed (name and picture only, in `localStorage`), so a returning visitor's control appears in its final shape before `/api/me` answers. Pages that carry `auth-state` are sent with `Cache-Control: private`, since they now differ per visitor.
- **No request while hidden.** A compact control that is hidden (`display: none`) waits to call `/api/me` until it is shown.

**Theming.** Set the `--ps-*` custom properties on the element; declarations from your page win over the component's own light and dark defaults, so mapping them to your own variables makes it follow your themes:

| Property                                                                                                          | Used for                                                  |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `--ps-control-height`                                                                                             | The pill's height and the avatar's diameter (`2rem`)      |
| `--ps-font`, `--ps-font-size`                                                                                     | Text in the pill and the menu                             |
| `--ps-text`                                                                                                       | Pill text                                                 |
| `--ps-control-bg`, `--ps-control-border`, `--ps-control-hover-bg`                                                 | The pill                                                  |
| `--ps-accent`, `--ps-accent-contrast`                                                                             | The initials avatar (background and letters), checkmarks  |
| `--ps-avatar-bg`, `--ps-avatar-fg`                                                                                | The avatar before a name is known                         |
| `--ps-focus-ring`                                                                                                 | Keyboard focus outline                                    |
| `--ps-menu-bg`, `--ps-menu-text`, `--ps-menu-muted`, `--ps-menu-border`, `--ps-menu-shadow`, `--ps-menu-hover-bg` | The account menu (default to the `--ps-dialog-*` colors)  |
| `--ps-danger`, `--ps-warning`                                                                                     | Admin item; Stop impersonating and the impersonation ring |

**Parts** for anything the properties don't cover: `login`, `login-icon`, `login-label`, `avatar-button`, `avatar`, `avatar-image`, `badge`, `menu`, `menu-header`, `menu-item`, `account-item`, `menu-pending`. Hiding the label leaves a circle exactly the size of the avatar, for narrow headers:

```css
@container header (max-width: 30rem) {
  power-strip::part(login-label) {
    display: none;
  }
}
```

**Reserving its space.** The element is empty until `power-strip.js` loads. Reserve its box so nothing in your header shifts when it appears — the avatar's size, or the pill's when the worker says the visitor is signed out:

```css
power-strip[variant='compact']:not(:defined) {
  display: inline-block;
  width: 2rem;
  height: 2rem;
}
power-strip[variant='compact'][auth-state='signed-out']:not(:defined) {
  width: 5.25rem; /* measure your pill */
}
```

**JavaScript.** The element exposes `state` (`'signed-in'`, `'signed-out'` or `'unknown'`), `user`, `account`, a `ready` promise (the first server answer) and `refresh()`, and fires a bubbling, composed `power-strip:change` event whenever the sign-in state changes, with `{ state, source, user, account }` in `detail` (`source` is `server`, `hint`, `cache` or `fallback`). The full strip fires it too.

## Access policy & provider entitlements

StartupAPI can gate access to paths and forward the visitor's login/entitlement status to your origin so it can render gated UI. This is **provider-agnostic infrastructure**; only Patreon currently implements perk-level (benefit/tier) checks — Google and Twitch participate at the login levels only.

### Path-based access policy

Configure an ordered list of rules (first match wins) mapping a path pattern to a requirement, plus a `default` for unmatched paths. Requirement modes:

- **`bypass`** — raw pass-through: no credential check, no identity resolution, no headers, no power-strip injection.
- **`public`** — anyone; the session is resolved and identity/entitlement headers are forwarded when present.
- **`authenticated`** — any logged-in user.
- **`entitlement`** — a provider condition: Patreon `active_patron`, a specific `benefit` (perk) ID, or a `tier` ID.
- **`feature`** — a [feature flag](#feature-flags) enabled for the visitor (`{ mode: 'feature', feature: 'new_dashboard' }`). Anonymous visitors pass only for features rolled out to everyone.

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

Admin users (those listed in `ADMIN_IDS`) bypass every `authenticated`/`entitlement` requirement and can reach those gated paths. `feature` requirements apply to admins like everyone else, so the gate always matches `X-StartupAPI-Features`; to try a feature as an admin, enable it for yourself in the admin dashboard. Their identity is still resolved and the usual identity/entitlement headers are forwarded to the origin — only the gate itself is skipped. (`bypass` paths remain a raw pass-through for everyone, with no identity resolution.)

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

For non-`bypass` paths the worker forwards `X-StartupAPI-Authenticated`, `X-StartupAPI-Login-Provider`, a compact `X-StartupAPI-Entitlements` JSON, and (for Patreon) `X-StartupAPI-Patreon-Active` / `-Tiers` / `-Benefits` alongside the existing `X-StartupAPI-User-Id` / `-Account-Id`. When [feature flags](#feature-flags) are configured, `X-StartupAPI-Features` lists the ids of the features enabled for the visitor (comma-separated).

### Keeping entitlements fresh

Entitlements are fetched at login and then kept fresh per-provider via three mechanisms. **Durations** below are a named-unit object (`{ days: 1 }`, `{ minutes: 15 }` — units are summed) or a plain number of milliseconds.

- **TTL** (`entitlementTtl`) — lazily re-check on the request path when the cache is older than the duration, using the OAuth refresh token. **On by default** for entitlement providers: default **1 day for Patreon** (memberships change slowly; this backstops missed webhooks) and 15 min for other providers. Pass a Duration to tune it (`entitlementTtl: { hours: 6 }`), or `entitlementTtl: false` to disable (e.g. rely on the webhook only).
- **Cron** (`entitlementCron: { schedule }`) — a scheduled re-sync of all of a provider's credentials. Off by default. The `scheduled()` handler is only present when at least one provider enables cron; you must also add a matching `triggers.crons` to your wrangler config.
- **Webhook** (Patreon only, `entitlementWebhook: true`) — off by default. Provide `PATREON_WEBHOOK_SECRET` (a secret, in env) and point a Patreon webhook at `<your-worker-url>/users/webhooks/patreon` (signature verified with HMAC-MD5).

Set `providers.patreon.campaignId` to disambiguate when a user belongs to multiple campaigns.

### Login session lifetime

Login sessions are **separate** from entitlement freshness: how long a user stays logged in (authentication) is independent of how often their paid status is re-checked (authorization). A user can stay logged in for weeks while their entitlements are refreshed every few minutes via TTL/webhook — and a churned subscriber still loses access within the entitlement window regardless of session validity.

- **Default lifetime is 30 days** with a **rolling window**: on activity, once less than half the window remains, the session expiry is pushed forward and the `session_id` cookie's `Max-Age` is refreshed. Active users effectively never have to re-login; idle users expire after the window.
- The `session_id` cookie is a **persistent cookie** (`Max-Age`), so it survives browser restarts.
- Configure the window via the factory (`session.ttl` is a Duration):

```ts
const api = createStartupAPI({
  session: { ttl: { days: 30 } }, // default; lower/raise as needed (or a number of ms)
});
```

> **Breaking in 0.5.0:** entitlement freshness moved from the `freshness: { ttl, cron, webhook }` block to flat per-provider keys `entitlementTtl` / `entitlementCron` / `entitlementWebhook`; `entitlementTtl` is now **on by default** (1 day for Patreon) and takes a Duration or `false`. The default session lifetime went from a fixed 24h (no renewal) to a **rolling 30 days**, and `session_id` is now a **persistent cookie**.

### Configuring via the factory

Environment variables hold only credentials/secrets and the per-deployment values (`ORIGIN_URL`, `AUTH_ORIGIN`, `USERS_PATH`, `ADMIN_IDS`, `ENVIRONMENT`). Everything else — provider scopes, Patreon campaign id, the access policy, entitlement freshness, plans and feature flags — is passed to `createStartupAPI(config)`. The plain re-export still works with defaults:

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
      // entitlementTtl is on by default (1 day for Patreon); tune with a Duration or set false to disable.
      entitlementTtl: { hours: 12 },
      entitlementCron: { schedule: '0 */6 * * *' },
      entitlementWebhook: true,
    },
  },
  session: { ttl: { days: 30 } }, // optional; login session lifetime (default 30d, rolling)
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

## Feature flags

Feature flags decouple deploying code from releasing it (see [specs/features.md](./specs/features.md)). Define features in code and grant them through plans:

```ts
const api = createStartupAPI({
  features: [
    { id: 'new_dashboard', name: 'New Dashboard', description: 'The redesigned home page.' }, // off until granted by a plan or override
    { id: 'reports', name: 'Reports', rolled_out_to_all_users: true }, // on for everyone
    { id: 'legacy_export', name: 'Legacy export', emergency_shutdown: true }, // off everywhere
  ],
  plans: [
    { slug: 'free', name: 'Free' },
    { slug: 'pro', name: 'Pro', features: ['new_dashboard'] }, // unknown ids fail at startup
  ],
});
```

A feature is resolved in this order:

1. `emergency_shutdown: true` or `enabled: false` → **off**.
2. `rolled_out_to_all_users: true` → **on**.
3. Otherwise it depends on the context: an account has it when its plan lists it or an admin enabled it for the account; a user has it when an admin enabled it for the user or when their current account has it.

Steps 1–2 come from code config and need no storage reads, so rolled-out and disabled features are free. Account and user data is only read when at least one feature needs step 3. The global switches change with a deploy; per-account and per-user overrides are stored in the Durable Objects.

How your app sees them:

- **Origin requests:** the `X-StartupAPI-Features` header. A client-sent value is always replaced.
- **HTML pages**, when you opt in with `featureDelivery.html` (below).
- **Browser:** `features` in the `/users/api/me` response, the full list of enabled ids.
- **Access policy:** the `feature` requirement mode.
- **Worker code:** `import { Feature, hasFeature } from '@startup-api/cloudflare'`, then `await hasFeature(env, userId, 'new_dashboard')` or `await Feature.require('new_dashboard').isEnabledForAccount(env, accountId)`.

### Only the difference travels

An app can define hundreds of features, and most of them are the same for everyone: rolled out, or not released yet. Sending all of them with every request and page would be mostly noise. So by default StartupAPI sends only what differs from each feature's **baseline**, its release state `rolled_out_to_all_users`:

- `new_dashboard`: on for this visitor, although not rolled out (an override, or granted by the plan);
- `-reports`: rolled out, but off right now (`emergency_shutdown` or `enabled: false`).

Every other feature is at its baseline. Your origin knows the baselines because it ships the same feature definitions, so it rebuilds the full state from the delta: a feature is on if it's listed, off if it's listed with `-`, and otherwise at its baseline. Most visitors get an empty delta, or a few beta features. A feature your origin knows but the proxy doesn't (deployed to the origin first) is never in the delta, so the origin's own default applies.

```ts
createStartupAPI({
  features: [...],
  featureDelivery: {
    header: 'delta', // default. 'enabled': every enabled id (for origins that don't know the baselines). 'none': no header.
    html: false, // default. true: write the visitor's features into HTML pages.
  },
});
```

With `header: 'delta'` the header is comma-separated (`new_dashboard,-reports`) and is empty when nothing differs.

> **Changed in 0.9:** the header used to list every enabled id. Set `featureDelivery: { header: 'enabled' }` to keep that.

### Feature flags in HTML pages

A static page can't read request headers, so with `featureDelivery: { html: true }` the proxy writes the visitor's features into HTML responses from the origin, so the page knows its flags at first paint, before any script runs:

- `<html data-startupapi-features="new_dashboard -reports">`: the same delta, space-separated, so CSS can match a token with `~=`. The attribute is always written, empty when nothing differs, so a script can tell "the proxy ran" from "no proxy" (local development, preview deployments).
- Any element tagged `data-startupapi-feature="<id>"` gets `data-startupapi-feature-off` when that feature is off for the visitor and loses it when it's on. Elements with ids the proxy doesn't know are left as the origin sent them, so ship them in their default state (with `data-startupapi-feature-off` when the feature is off by default). It's a dedicated attribute rather than `hidden`, so it never clashes with your own scripts toggling `hidden` on the same element.

```html
<button data-startupapi-feature="new_dashboard" data-startupapi-feature-off>Try the new dashboard</button>
```

```css
[data-startupapi-feature-off] {
  display: none !important;
}
```

```js
const tokens = new Set((document.documentElement.dataset.startupapiFeatures ?? '').split(' ').filter(Boolean));
const isOn = (id, baseline) => (tokens.has(id) ? true : tokens.has(`-${id}`) ? false : baseline);
```

These pages differ per visitor, so they are sent with `Cache-Control: private`. Non-HTML responses are never touched.

Manage overrides in the admin dashboard (`/users/admin/`): the **Features** section lists each feature's status, with its `description` when it has one, and how many users and accounts have overrides, and each user's and account's page (`/users/admin/users/<id>`, `/users/admin/accounts/<id>`) has its feature checkboxes. Features that are shut down, disabled, rolled out to everyone, or (for accounts) granted by the plan can't be overridden there. In code, use `Feature.require(id).enableForAccount` / `removeForAccount` / `enableForUser` / `removeForUser` and `getAccountCount` / `getUserCount`. The dashboard uses this admin API:

| Method           | Path (under `/users/admin/api/`)                                    | Returns / does                                                                                                    |
| ---------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `GET`            | `features`                                                          | `{ total_users, total_accounts, features }`: definitions, state (`on` / `off` / `contextual`) and override counts |
| `GET`            | `accounts/:id/features`                                             | Each feature with `active`, `override`, and `plan` when the account's plan grants it                              |
| `GET`            | `users/:id/features`                                                | Each feature with `active` (through the current account), `override`, and the user's `accounts` that have it      |
| `PUT` / `DELETE` | `accounts/:id/features/:featureId`, `users/:id/features/:featureId` | Enable or remove an override                                                                                      |

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to clone, run, test, and submit changes to the framework.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
