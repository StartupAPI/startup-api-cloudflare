/** Shared, styled error page for the auth flow, so a failed login renders a card instead of raw text. */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render a minimal styled "sign-in failed" page matching the atproto handle form's look. */
export function renderAuthError(message: string, status = 500): Response {
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
  .detail { background: #f7f8fa; border: 1px solid #e3e7ee; border-radius: 8px; padding: 0.6rem 0.7rem; font-size: 0.82rem; color: #555; word-break: break-word; }
  a { display: inline-block; margin-top: 1rem; color: #0085FF; text-decoration: none; font-size: 0.9rem; }
</style>
</head>
<body>
  <div class="card">
    <h1>Sign-in failed</h1>
    <p>We couldn't complete your sign-in. Please double-check your details and try again.</p>
    <div class="detail">${escapeHtml(message)}</div>
    <a href="javascript:history.back()">&larr; Go back</a>
  </div>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
