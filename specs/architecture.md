# System Architecture & Utilities

## Overview
StartupAPI is built as a modular PHP application, designed for flexibility and rapid development. It employs a "Pluggable" architecture for core features and relies on established libraries for templating and frontend presentation.

## Core Architecture

### 1. Initialization & Bootstrapping
*   **Entry Point**: `global.php` initializes the environment, loads configuration (`users_config.php`), and starts the session.
*   **Main Class**: `StartupAPI` (`classes/StartupAPI.php`) serves as the central static accessor for global state and helper methods.
*   **Autoloading**: Uses standard `require_once` patterns and Composer/library autoloaders where applicable.

### 2. Module System
*   **Base Class**: `StartupAPIModule`.
*   **Concept**: Functionality like Authentication, Payments, and Emailing are encapsulated in modules.
*   **Registry**: `UserConfig::$all_modules` holds the list of active modules.
*   **Extensibility**: Developers can create new modules by extending the base class and registering them in the config.

### 3. Frontend & Templating
*   **Engine**: **Twig** is the primary templating engine (`twig/`).
*   **Themes**: Support for multiple themes (`themes/awesome`, `themes/classic`).
*   **UI Framework**: Heavy reliance on **Bootstrap** (v2/v3) for responsive layout and components.
*   **Assets**: `bootswatch` integration allows for easy visual customization.

### 4. Utilities
*   **Database Migration**: `dbupgrade.php` manages schema versioning and updates, ensuring the database stays in sync with the code.
*   **Cron**: `cron.php` handles scheduled background tasks, essential for subscription billing and maintenance.
*   **Dependency Check**: `depcheck.php` verifies that the server environment meets all requirements.

## File Structure
*   `classes/`: Core logic and business entities.
*   `modules/`: Pluggable functional blocks.
*   `admin/`: Administrative interface logic.
*   `themes/` & `view/`: Presentation layer.
*   `controller/`: Request handling logic (MVC pattern).
