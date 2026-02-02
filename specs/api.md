# Developer Platform / API

## Overview

StartupAPI provides a RESTful API (v1) to allow external applications and client-side frontends to interact with the platform. It features a structured endpoint system, parameter validation, and authentication.

## Key Components

### 1. Endpoint Architecture

- **Base Class**: `Endpoint` (`classes/API/Endpoint.php`).
- **Registration**: Endpoints are registered to a namespace and HTTP method via `Endpoint::register()`.
- **Discovery**: `api.php` handles routing based on the URL structure (e.g., `/api/v1/user`).

### 2. Request Handling

- **Routing**: Logic in `Endpoint::getEndpoint()` resolves the URL slug to a specific handler.
- **Parameters**:
  - **Definition**: Endpoints define expected parameters (`Parameter` class).
  - **Validation**: Built-in type checking and required/optional validation.
  - **Parsing**: `parseURLEncoded` helper for processing input.

### 3. Authentication & Security

- **Base Class**: `AuthenticatedEndpoint`.
- **Mechanism**: automatically checks for a valid session or API token before processing the request.
- **Exceptions**:
  - `UnauthenticatedException` (401)
  - `UnauthorizedException` (403)
  - `MethodNotAllowedException`

### 4. Core Endpoints

- **Namespace**: `v1` (configurable).
- **User**: `v1/User/Get.php` - Retrieve current user details.
- **Accounts**: `v1/Accounts.php` - List and manage user accounts.

## Documentation

- **Swagger/OpenAPI**: The project includes tools (`tools/swagger_validate.py`) and UI (`swagger-ui/`) to generate and display interactive API documentation.
