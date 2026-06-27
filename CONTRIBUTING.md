# Contributing to Startup API Cloudflare

Thanks for your interest in improving Startup API! This guide is for developers working on the **framework itself** (the [`@startup-api/cloudflare`](https://www.npmjs.com/package/@startup-api/cloudflare) package in this repository).

> Building an application _on top of_ Startup API? You don't need to clone this repo — scaffold a project with `npm create startup-api` instead. See the [README](./README.md#installation).

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or newer (and npm)
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) if you want to deploy a test worker

## Clone and install

```bash
git clone https://github.com/StartupAPI/startup-api-cloudflare.git
cd startup-api-cloudflare
npm install
```

## Local development

```bash
npm run dev      # start the worker locally (uses wrangler.local.jsonc)
```

This serves the worker at `http://localhost:8787`. Local configuration and secrets live in `wrangler.local.jsonc` and `.dev.vars` — never commit changes to `.env` or `.dev.vars`.

To deploy your own test worker to Cloudflare:

```bash
npm run deploy
```

## Tests, linting, and formatting

```bash
npm test           # runs eslint then the vitest suite
npm run lint       # eslint only
npm run format     # prettier --write across the repo
```

- When you add a feature, add tests that cover the new code.
- Run `npm run lint` and fix anything it flags before committing.
- Run `npm run format` after changes so the diff stays prettier-clean.
- Every time you edit `wrangler.jsonc`, run `npm run cf-typegen` to regenerate the binding types.

## Conventions

- TypeScript strict mode; single quotes and trailing commas (enforced by prettier).
- Internal worker routes are prefixed with the configured `usersPath`; non-admin API paths start with `/${usersPath}/api/` and admin paths with `/${usersPath}/admin/api/`.
- Call Durable Objects via RPC rather than `fetch()`, and name stub variables after the DO they refer to.

See [AGENTS.md](./AGENTS.md) for the full set of repository conventions.

## Submitting changes

1. Create a branch for your change.
2. Make sure `npm test` passes and the code is formatted.
3. Open a Pull Request describing what changed and why.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](./LICENSE).
