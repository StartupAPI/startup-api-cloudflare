# Startup API Cloudflare App

This application uses Cloudflare Developer Platform, including Workers and DurableObjects to implement functionality that every web application needs on day zero.

## Setup commands

- Install deps: `npm install`
- Start dev server: `npm dev`
- Run tests: `npm test`
- Run prettier: `npm format`

## Code style

- TypeScript strict mode
- Single quotes, trailing comma
- Run `npm run format` to format the code after each prompt

## Script rules

- Every time you update wrangler.jsonc file, run `npm run cf-typegen` command
- After you update any code, run `npm run format` command

## Worker implementation

- Internal worker routes all start with `${usersPath}`, make sure to always prefix them
- Never override `.env` and `.dev.vars` files
- When calling DurableObjects from Workers or other DurableObjects, always use RPC instead of fetch()
- When generating DO stubs, always call stub variable to reflect which DO it refers to

## API

- All non-admin API paths start with `/${usersPath}/api/`
- All admin API paths start with `/${usersPath}/admin/api/`
