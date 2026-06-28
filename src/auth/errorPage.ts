/**
 * Styled error page for the auth flow.
 *
 * Auth error messages frequently embed UNTRUSTED text from outside our trust boundary: the
 * user-supplied handle, and raw response bodies from a user's PDS or authorization server
 * (e.g. `Token request failed: 400 <body>`). We never render that verbatim. Protection is layered:
 *
 *   1. Sanitize  — reduce the message to a bounded, single-line, printable-only string, dropping
 *                  control characters and Unicode format/bidi tricks that survive HTML escaping.
 *   2. Escape    — HTML-encode the result for text context.
 *   3. Contain   — serve under a restrictive Content-Security-Policy (no script can run) plus
 *                  `nosniff`, so even a bypass of steps 1–2 cannot execute code or be re-sniffed.
 */

/** Hard cap on rendered detail length — external bodies can be arbitrarily large. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Reduce untrusted text to a bounded, single-line, printable string.
 *  - Replaces C0/C1 controls (`\p{Cc}`), format chars incl. bidi overrides & zero-width (`\p{Cf}`),
 *    and line/paragraph separators (`\p{Zl}`/`\p{Zp}`) with spaces.
 *  - Collapses whitespace and trims.
 *  - Truncates to a hard cap with an ellipsis.
 */
function sanitizeText(input: unknown): string {
  const raw = typeof input === 'string' ? input : String(input ?? '');
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_DETAIL_LENGTH ? `${cleaned.slice(0, MAX_DETAIL_LENGTH - 1)}…` : cleaned;
}

/** HTML-encode for text/attribute context. Applied only after {@link sanitizeText}. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Content-Security-Policy for the error page. `default-src 'none'` blocks every resource type
 * (scripts, images, frames, connections); the page needs only its own inline `<style>`, so we
 * additively allow `style-src 'unsafe-inline'`. With no `script-src`, no inline or external script
 * can ever run — neutralizing HTML/script injection as a class, independent of escaping.
 */
const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/** Render a minimal styled "sign-in failed" page matching the atproto handle form's look. */
export function renderAuthError(message: string, status = 500): Response {
  const detail = escapeHtml(sanitizeText(message));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign-in failed</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f5f7fb; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.08); width: 360px; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; color: #b3261e; }
  p { font-size: 0.9rem; color: #444; margin: 0 0 1rem; line-height: 1.45; }
  .detail { background: #f7f8fa; border: 1px solid #e3e7ee; border-radius: 8px; padding: 0.6rem 0.7rem; font-size: 0.82rem; color: #555; word-break: break-word; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="card">
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
    },
  });
}
