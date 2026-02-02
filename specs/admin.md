# Administrative Control

## Overview

The Admin Panel provides a centralized interface for platform owners to manage users, accounts, subscriptions, and system settings. It is secured to allow access only to users with global administrative privileges.

## Key Components

### 1. Admin Menu System

- **Class**: `MenuElement` (Abstract) and subclasses in `admin/adminMenus.php`.
- **Structure**: Hierarchical menu defining the admin navigation.
- **Features**:
  - Supports nested sub-menus.
  - Handles active state highlighting.
  - Can disable menu items with "Coming soon" tooltips.

### 2. User & Account Administration

- **Users**: (`admin/users.php`) List, search, and edit user details.
- **Accounts**: (`admin/accounts.php`) Manage account statuses, view details, and intervene in billing issues.
- **Impersonation**: Admins can log in as any user to reproduce bugs or assist with configuration.

### 3. Subscription Management

- **Plans**: (`admin/plans.php`) View and edit subscription plans.
- **Outstanding Payments**: (`admin/outstanding.php`) Monitor failed charges and overdue accounts.
- **Transaction Logs**: (`admin/transaction_log.php`) Audit trail of all financial transactions.

### 4. System Settings & Modules

- **Settings**: (`admin/settings.php`) General platform configuration.
- **Modules**: (`admin/modules.php`) Enable/disable and configure system modules (Authentication, Payment, etc.).

## Security

- **Access Control**: All admin pages verify that the current user has global admin privileges (`Account::ROLE_ADMIN` context on the system account or specific flag).
- **Audit**: Critical actions are logged.
