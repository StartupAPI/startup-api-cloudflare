/**
 * Styled error page for the auth flow.
 *
 * Auth error messages frequently embed UNTRUSTED text from outside our trust boundary: the
 * user-supplied handle, and raw response bodies from a user's PDS or authorization server
 * (e.g. `Token request failed: 400 <body>`). Protection is layered:
 *
 *   1. Encode  — the untrusted message is HTML-escaped with `he` (a battle-tested, dependency-free
 *                output encoder) before it ever reaches the markup. We do not hand-roll escaping.
 *   2. Contain — the page is served under a restrictive Content-Security-Policy (no script may run)
 *                plus `nosniff`, so even an encoding bypass cannot execute code or be re-sniffed.
 *
 * Theming matches the rest of the app: we link `/users/style.css` and use its CSS variables, so the
 * page follows the user's OS / chosen theme via `prefers-color-scheme` exactly like profile.html.
 * The CSP allows `style-src 'self'` for that same-origin stylesheet; scripts remain fully blocked.
 */
import { escape as escapeHtml } from 'he';

/** Hard cap on rendered detail length — external bodies can be arbitrarily large. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Content-Security-Policy for the error page. `default-src 'none'` blocks every resource type
 * (scripts, images, frames, connections). We additively allow `style-src 'self' 'unsafe-inline'`
 * for the linked `style.css` (same-origin) and the page's own inline `<style>`. With no `script-src`,
 * no inline or external script can ever run — neutralizing HTML/script injection as a class.
 * `frame-ancestors 'none'` is listed explicitly because it does NOT fall back to `default-src`, and
 * without it the page could be framed by another origin (clickjacking) — unwanted for an auth endpoint.
 */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Render a minimal styled "sign-in failed" page that matches the app theme. */
export function renderAuthError(message: string, status = 500, usersPath = '/users/'): Response {
  const text = typeof message === 'string' ? message : String(message ?? '');
  const bounded = text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
  const detail = escapeHtml(bounded).trim();
  const stylesheet = `${escapeHtml(usersPath)}style.css`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign-in failed</title>
<link rel="stylesheet" href="${stylesheet}" />
<style>
  body { margin: 0; padding: 1rem; box-sizing: border-box; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--text); }
  .auth-card { background: var(--surface); border: 1px solid var(--border); padding: 2rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); width: 360px; max-width: 100%; box-sizing: border-box; }
  .auth-card h1 { font-size: 1.15rem; margin: 0 0 0.75rem; color: var(--danger); }
  .auth-card p { font-size: 0.9rem; color: var(--text-secondary); margin: 0 0 1rem; line-height: 1.45; }
  .auth-card .detail { background: var(--surface-muted); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.7rem; font-size: 0.82rem; color: var(--text-faint); word-break: break-word; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="auth-card">
    <h1>Sign-in failed</h1>
    <p>We couldn't complete your sign-in. Please return to the sign-in page and try again.</p>
    ${detail ? `<div class="detail">${detail}</div>` : ''}
  </div>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      // Reflects a user handle / remote server message — never let a browser or intermediary cache it.
      'Cache-Control': 'no-store',
    },
  });
}
