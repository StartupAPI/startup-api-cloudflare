# Subscription & Billing Engine

## Overview
The Subscription & Billing engine provides a flexible system for monetizing the application. It supports multiple subscription plans, varying payment schedules, and abstract payment gateways.

## Key Components

### 1. Plans
*   **Class**: `Plan` (`classes/Plan.php`)
*   **Definition**: Represents a subscription tier (e.g., "Basic", "Pro").
*   **Attributes**:
    *   `slug`: Unique identifier.
    *   `name`: Display name.
    *   `capabilities`: Feature flags enabled for this plan.
    *   `downgrade_to_slug`: Fallback plan upon cancellation.
    *   `grace_period`: Days to wait for payment before downgrading.
*   **Hooks**: `account_activate_hook` and `account_deactivate_hook` for custom logic during plan changes.

### 2. Payment Schedules
*   **Class**: `PaymentSchedule` (`classes/PaymentSchedule.php`)
*   **Definition**: Defines how often and how much a user is charged for a plan.
*   **Attributes**:
    *   `charge_amount`: Cost per period.
    *   `charge_period`: Frequency of billing (in days).
    *   `is_default`: Default schedule for a plan.

### 3. Payment Engines
*   **Class**: `PaymentEngine` (`classes/PaymentEngine.php`)
*   **Role**: Abstract interface for payment providers.
*   **Implementations**:
    *   **Stripe**: Credit card processing.
    *   **External**: Manual or off-platform payments.
*   **Functionality**: Handles charge requests, recurrent billing setup, and webhook processing.

### 4. Account Billing State
*   **Management**: Handled within the `Account` class.
*   **States**:
    *   Active plan.
    *   Next plan (scheduled change).
    *   Outstanding balance.
*   **Lifecycle**:
    *   **Upgrades/Downgrades**: Handled with proration logic.
    *   **Cancellation**: Reverts to the "downgrade" plan (usually Free) after the current period or grace period.

## Configuration
*   **Plan Definition**: Plans and schedules are defined in `users_config.php` passed to `Plan::init()`.
*   **Gateways**: Credentials for providers like Stripe are configured in `UserConfig`.

## User Interface
*   **Plans Page** (`plans.php`): Displays available plans and allows users to subscribe or switch.
*   **Billing History**: Users can view past transactions and receipts (managed by `Account` and `TransactionLogger`).
