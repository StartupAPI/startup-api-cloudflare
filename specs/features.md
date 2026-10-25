# Feature Flags & Rollout Framework

## Overview

The Feature Framework allows developers to decouple code deployment from feature release. It supports granular feature flags, gradual rollouts, subscription-based feature gating, and emergency circuit breakers (load shedding) to ensure system stability.

## Key Components

### 1. Feature Entity

- **Class**: `Feature` (`src/features/Feature.ts`, schema in `src/schemas/feature.ts`)
- **Purpose**: Represents a distinct piece of functionality that can be toggled.
- **Attributes**:
  - `id`: Unique string key (lowercase letters, digits, `_`, `-`), like plan slugs.
  - `name`: Human-readable display name.
  - `enabled`: Global master switch (must be true for feature to work anywhere). Default `true`.
  - `rolled_out_to_all_users`: If true, enables the feature globally (overrides specific settings). Default `false`.
  - `emergency_shutdown`: Temporary kill switch to disable the feature strictly. Default `false`.
- The global switches are code configuration and change with a deploy. A runtime (data-backed) emergency shutdown is part of Stability & Load Shedding below.

### 2. Stability & Load Shedding

_Not implemented yet._

- **Shutdown Priority**: Each feature has a `shutdown_priority` (int).
  - Used to automate or guide the disabling of non-essential features during system overload.
  - Lower priority features (or specifically assigned priorities) can be sacrificed to keep core functionality running.
- **Runtime emergency shutdown**: flipping `emergency_shutdown` without a deploy (requires a data lookup).

### 3. Resolution Hierarchy

The system determines if a feature is active for a specific context (User or Account) based on the following precedence (`src/features/resolve.ts`):

1.  **Emergency Check**: If `emergency_shutdown` is true or global `enabled` is false → **DISABLED**.
2.  **Global Rollout**: If `rolled_out_to_all_users` is true → **ENABLED**.
3.  **Context Specifics**:
    - **Accounts**:
      1.  **Plan**: Checked via `Plan.hasFeatureEnabled` (the plan's `features` list).
      2.  **Database Override**: Checked against the `account_features` table in `AccountDO`.
    - **Users**:
      1.  **Database Override**: Checked against the `user_features` table in `UserDO`.
      2.  **Propagation**: If the User's _Current Account_ has the feature enabled, the User inherits it.

Steps 1–2 use code configuration only, so they never read storage. Durable Objects are read only when a feature needs step 3. Resolution runs in the worker; the Durable Objects only store the override sets.

## Usage & Workflows

### Definition

Features are defined in the factory configuration. Plans grant features through their `features` list, which is separate from plan `capabilities`. A plan that lists an unknown feature id fails at startup.

```ts
const api = createStartupAPI({
  features: [{ id: 'new_dashboard', name: 'New Dashboard' }],
  plans: [
    { slug: 'free', name: 'Free' },
    { slug: 'pro', name: 'Pro', features: ['new_dashboard'] },
  ],
});
```

### Checking Availability

The origin app receives the enabled feature ids in the `X-StartupAPI-Features` header. The browser gets them as `features` in `/api/me`. Paths can be gated with the access policy requirement `{ mode: 'feature', feature: 'new_dashboard' }`.

In worker code:

```ts
import { Feature, hasFeature } from '@startup-api/cloudflare';

// Check for a user
if (await hasFeature(env, userId, 'new_dashboard')) {
  // Show new dashboard
}

// Check for an account (e.g. during billing or background tasks)
if (await Feature.require('new_dashboard').isEnabledForAccount(env, accountId)) {
  // Process feature logic
}
```

### Management

- **Enabling/Disabling**: `enableForAccount`, `removeForAccount`, `enableForUser`, and `removeForUser` manage overrides. The admin API exposes the same operations under `/${usersPath}admin/api/accounts/:id/features/:featureId` and `/${usersPath}admin/api/users/:id/features/:featureId` (`PUT` / `DELETE`).
- **Reporting**: `getUserCount()` and `getAccountCount()` return the number of overrides for a feature, from an index in `SystemDO`. Accounts that get the feature from their plan are not counted. `GET /${usersPath}admin/api/features` lists all features with these counts.
