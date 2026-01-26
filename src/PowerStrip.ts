export async function injectPowerStrip(response: Response, usersPath: string): Promise<Response> {
  const contentType = response.headers.get('Content-Type');

  if (contentType && contentType.includes('text/html')) {
    // Inject a script tag and a custom element into the proxied HTML pages.
    // The script is loaded from the USERS_PATH, which is intercepted by this worker.
    return new HTMLRewriter()
      .on('body', {
        element(element) {
          element.prepend(
            `<script src="${usersPath}power-strip.js" async></script>` +
              '<power-strip style="position: absolute; top: 0; right: 0; z-index: 9999; padding: 0.1rem; border-radius: 0 0 0 0.3rem; fill: #ccc;">' +
              '<svg viewBox="0 0 24 24" style="width: 1rem; height: 1rem;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>' +
              '</power-strip>',
            { html: true },
          );
        },
      })
      .transform(response);
  }

  return response;
}
