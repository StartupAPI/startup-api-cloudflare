# User Identity & Access Management (IAM)

## Overview
The IAM system in StartupAPI is designed to handle user authentication, session management, and profile administration. It supports a wide range of authentication methods through a modular architecture, including email/password, email verification (passwordless), and various OAuth providers.

## Key Components

### 1. User Entity
*   **Class**: `User` (`classes/User.php`)
*   **Responsibilities**:
    *   Represents a registered user.
    *   Manages login sessions via `CookieStorage`.
    *   Handles user profile data.
    *   Provides static methods for retrieval (`User::get()`) and access control (`User::require_login()`).

### 2. Authentication Modules
Authentication is handled via subclasses of `AuthenticationModule` (extending `StartupAPIModule`).
*   **Location**: `modules/`
*   **Types**:
    *   **Username/Password**: Standard email and password login (`modules/usernamepass`).
    *   **Verified Email**: Login via a link sent to email (`modules/email`).
    *   **OAuth Providers**: Facebook, Google, Twitter, GitHub, LinkedIn, etc.
    *   **Service Auth**: Integration with platforms like Amazon and Etsy.

### 3. Session Management
*   **Mechanism**: Encrypted cookies.
*   **Storage**: `MrClay_CookieStorage`.
*   **Security**: Supports `HttpOnly` and `Secure` flags.
*   **Configuration**: `UserConfig::$SESSION_SECRET` used for encryption.

### 4. Registration & Login Flows
*   **Registration**: Users can sign up via enabled modules. New users are automatically provisioned a personal account.
*   **Login**: Unified login page presenting available authentication options.
*   **Impersonation**: Administrators can impersonate other users for support purposes (`User::get(true)` allows impersonation).

## Configuration
*   **Modules**: Enabled in `users_config.php`.
*   **Namespace**: `UserConfig` class holds global IAM settings.

## Security Features
*   **CSRF Protection**: `UserTools::preventCSRF()` (implied usage in forms).
*   **Password Hashing**: Implemented within the `usernamepass` module (details in module code).
*   **Access Control**: `User::require_login()` enforces authentication on protected pages.
