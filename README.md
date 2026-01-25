# Startup API Cloudflare App

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

This application uses the Cloudflare Developer Platform, including Workers and DurableObjects, to implement foundational web application functionality. It acts as a transparent proxy for your application, allowing you to inject custom UI elements and intercept specific paths.

## Features

- **Transparent Proxying:** Forwards requests to your origin application.
- **HTML Injection:** Uses `HTMLRewriter` to inject scripts and custom elements (like `<power-strip>`) into your HTML pages.
- **Path Interception:** Intercepts requests to a configurable path to serve internal assets.

## Installation

### Option 1: Cloudflare Workers GitHub Integration (Recommended)

This is the easiest way to deploy and keep your worker up to date.

1. **Fork this repository** to your own GitHub account.
2. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
3. Navigate to **Workers & Pages** > **Create application**.
4. Select **Workers** and click **Connect to Git**.
5. Select your forked `cloudflare` repository.
6. Deploy the Worker.
7. In the **Settings** tab of your Worker, go to **Variables** and add the required `ORIGIN_URL` (see [Configuration](#configuration-details) below).

### Option 2: Manual Installation (CLI)

Use this option if you want to deploy from your local machine.

1. **Clone and Install**
   ```bash
   git clone https://github.com/StartupAPI/cloudflare.git
   cd cloudflare
   npm install
   ```
2. **Configure Environment Variables**
   Update `wrangler.jsonc` with your settings.
3. **Deploy**
   ```bash
   npm run deploy
   ```

## Configuration Details

### How to set environment variables

- **Using Cloudflare Dashboard (Recommended):**
  1. Go to **Workers & Pages**.
  2. Select your worker.
  3. Navigate to **Settings** > **Variables**.
  4. Click **Add variable** under **Environment Variables**.
  5. Add `ORIGIN_URL` and any optional variables.
  6. Click **Save and deploy**.

- **Using `wrangler.jsonc`:**
  Add the variables to the `"vars"` object in your configuration file. See [Cloudflare documentation](https://developers.cloudflare.com/workers/wrangler/configuration/#environment-variables) for more details.

| Variable     | Required | Default   | Description                                                                    |
| :----------- | :------- | :-------- | :----------------------------------------------------------------------------- |
| `ORIGIN_URL` | **Yes**  | N/A       | The base URL of your origin application (e.g., `https://your-app-origin.com`). |
| `USERS_PATH` | No       | `/users/` | The path used to serve internal assets like `power-strip.js`.                  |

### Example `wrangler.jsonc` snippet:

```json
{
  "vars": {
    "ORIGIN_URL": "https://your-app-origin.com",
    "USERS_PATH": "/users/"
  }
}
```

## How It Works

1. **Request Interception:** The worker receives all incoming requests.
2. **Path Mapping:** If the request path starts with `USERS_PATH`, the worker serves assets directly from the `public/users/` directory.
3. **Proxying:** All other requests are proxied to the configured `ORIGIN_URL`.
4. **Injection:** For `text/html` responses, the worker injects a `<script>` tag and a `<power-strip>` custom element before serving the content to the user.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) for details.
