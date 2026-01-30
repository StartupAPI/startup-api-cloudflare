# Feature Flags & Rollout Framework

## Overview

The Feature Framework allows developers to decouple code deployment from feature release. It supports granular feature flags, gradual rollouts, subscription-based feature gating, and emergency circuit breakers (load shedding) to ensure system stability.

## Key Components

### 1. Feature Entity

- **Class**: `Feature` (`classes/Feature.php`)
- **Purpose**: Represents a distinct piece of functionality that can be toggled.
- **Attributes**:
  - `id`: Unique numeric identifier (constant).
  - `name`: Human-readable display name.
  - `enabled`: Global master switch (must be true for feature to work anywhere).
  - `rolled_out_to_all_users`: If true, enables the feature globally (overrides specific settings).
  - `emergency_shutdown`: Temporary kill switch to disable the feature strictly.

### 2. Stability & Load Shedding

- **Shutdown Priority**: Each feature has a `shutdown_priority` (int).
  - Used to automate or guide the disabling of non-essential features during system overload.
  - Lower priority features (or specifically assigned priorities) can be sacrificed to keep core functionality running.

### 3. Resolution Hierarchy

The system determines if a feature is active for a specific context (User or Account) based on the following precedence:

1.  **Emergency Check**: If `emergency_shutdown` is true or global `enabled` is false → **DISABLED**.
2.  **Global Rollout**: If `rolled_out_to_all_users` is true → **ENABLED**.
3.  **Context Specifics**:
    - **Accounts**:
      1.  **Plan**: Checked via `Plan::hasFeatureEnabled`.
      2.  **Database Override**: Checked against `u_account_features`.
    - **Users**:
      1.  **Propagation**: If the User's _Current Account_ has the feature enabled, the User inherits it.
      2.  **Database Override**: Checked against `u_user_features`.

## Usage & Workflows

### Definition

Features are typically defined in the global configuration (e.g., `users_config.php`) using constants for IDs to ensure they are available at bootstrap.

```php
define('FEATURE_NEW_DASHBOARD', 101);
new Feature(FEATURE_NEW_DASHBOARD, 'New Dashboard', true, false);
```

### Checking Availability

Developers check for feature availability before rendering UI elements or executing logic.

```php
// Check for a user
if ($user->hasFeature(FEATURE_NEW_DASHBOARD)) {
    // Show new dashboard
}

// Check for an account (e.g. during billing or background tasks)
if ($feature->isEnabledForAccount($account)) {
    // Process feature logic
}
```

### Management

- **Enabling/Disabling**: Methods like `enableForAccount`, `removeForAccount`, `enableForUser`, and `removeForUser` manage specific overrides in the database.
- **Reporting**: `getUserCount()` and `getAccountCount()` provide usage statistics for specific features.
