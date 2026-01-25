export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (env.ORIGIN_URL) {
      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;

      // Create a new request to the origin, ensuring the Host header matches the origin
      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('Host', url.host);

      return fetch(newRequest);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
