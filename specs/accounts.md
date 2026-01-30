# Team & Account Management

## Overview
StartupAPI uses a multi-tenant architecture where users belong to "Accounts". An Account acts as a container for data, subscriptions, and team members, effectively allowing a single user to participate in multiple organizations or workspaces.

## Key Components

### 1. Account Entity
*   **Class**: `Account` (`classes/Account.php`)
*   **Role**: The primary unit of tenancy and billing.
*   **Attributes**:
    *   `id`: Unique identifier.
    *   `name`: Account name.
    *   `plan`: Current subscription plan.
    *   `active`: Status flag.

### 2. User-Account Relationship
*   **Many-to-Many**: A user can belong to multiple accounts; an account can have multiple users.
*   **Roles**:
    *   `Account::ROLE_USER` (0): Standard member.
    *   `Account::ROLE_ADMIN` (1): Account administrator (can manage billing and users).
*   **Context**: Users switch between accounts. `User::getCurrentAccount()` retrieves the active context.

### 3. Invitations
*   **Class**: `Invitation` (`classes/Invitation.php`)
*   **Functionality**: Allows adding users to the system or specific accounts.
*   **Flows**:
    *   **Admin Invite**: System admins invite users to the platform.
    *   **Account Invite**: Account admins invite members to their team.
*   **Data**: Stores `code`, `issuer`, `recipient_email`, `target_account_id`.

## Workflows
*   **Creation**: Every new user gets a personal Account by default.
*   **Switching**: Users can switch context via the UI (usually top navigation).
*   **Membership**: Account admins can add/remove users via the Account Settings page.

## Security
*   **Isolation**: Data queries should be scoped to the `current_account` to ensure tenant isolation.
*   **Permissions**: Only Account Admins can modify billing settings or plan subscriptions.
