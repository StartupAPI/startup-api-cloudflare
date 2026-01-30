# Development Plan: StartupAPI Cloudflare (Durable Object + SQLite)

## 🏗️ Phase 1: Storage & Identity Mapping

- **Durable Object Schema:** Implement SQLite-based storage within DO classes.
- **Direct ID Resolution:** Use Durable Object's `idFromName` to map unique identifiers (e.g., `google:12345`) directly to DO instances, eliminating the need for a separate KV registry.
- **Data Isolation:** Ensure each user/tenant has a dedicated SQLite file within their DO for maximum privacy and performance.

## 🔐 Phase 2: High-Performance Auth

- **Stateful Sessions:** Move session logic into DO memory for <10ms validation.
- **OAuth Handlers:** Centralize OAuth callbacks to update the specific User DO via internal fetch requests.
- **Account Switching:** Handle multi-tenant access by allowing a User DO to "point" to multiple Account DOs.

## 📈 Phase 3: Real-time Features

- **WebSocket Integration:** Use DO's native WebSocket support to push live "Badge Awarded" alerts to the frontend.
- **SQL Analytics:** Run local SQL queries within the DO to generate per-user transaction reports and audit logs.

## 🛠️ Phase 4: Modernized UI Injection

- **Edge Proxying:** Continue using `HTMLRewriter` to inject the `<power-strip>`, but pull the user state directly from the warm Durable Object.
