export async function injectPowerStrip(response: Response, usersPath: string, providers: string[]): Promise<Response> {
  const contentType = response.headers.get('Content-Type');

  if (contentType && contentType.includes('text/html')) {
    const providersAttr = providers.join(',');

    // Track whether the page author placed their own <power-strip> element.
    // If they did, we respect their placement/styling and only load the script.
    let hasUserPowerStrip = false;

    return new HTMLRewriter()
      .on('power-strip', {
        element(element) {
          hasUserPowerStrip = true;

          // Fill in the active providers for the author so their element works
          // out of the box, unless they explicitly chose their own list.
          if (!element.hasAttribute('providers')) {
            element.setAttribute('providers', providersAttr);
          }
        },
      })
      .on('body', {
        element(element) {
          // The script is always needed to define the <power-strip> custom element.
          // It is loaded from the USERS_PATH, which is intercepted by this worker.
          element.prepend(`<script src="${usersPath}power-strip.js" async></script>`, { html: true });

          // Defer the component decision until the end of <body>, by which point
          // the streaming parser has seen any author-supplied <power-strip>.
          element.onEndTag((end) => {
            if (!hasUserPowerStrip) {
              end.before(
                `<power-strip providers="${providersAttr}" style="position: absolute; top: 0; right: 0; z-index: 9999; border-radius: 0 0 0 0.3rem;">` +
                  '<svg viewBox="0 0 24 24" style="width: 1rem; height: 1rem;"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>' +
                  '</power-strip>',
                { html: true },
              );
            }
          });
        },
      })
      .transform(response);
  }

  return response;
}
