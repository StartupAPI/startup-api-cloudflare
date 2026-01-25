export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (env.ORIGIN_URL) {
      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;

      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('Host', url.host);

      const response = await fetch(newRequest);
      const contentType = response.headers.get('Content-Type');

      if (contentType && contentType.includes('text/html')) {
        return new HTMLRewriter()
          .on('body', {
            element(element) {
              element.prepend('<script src="/users/power-strip.js" async></script>', { html: true });
              element.prepend('<power-strip></power-strip>', { html: true });
            },
          })
          .transform(response);
      }

      return response;
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
