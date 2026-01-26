import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './UserDO';

const DEFAULT_USERS_PATH = '/users/';

export { UserDO };

export default {
  /**
   * Main Worker fetch handler.
   * Intercepts requests, serves static assets from `public/users` if applicable,
   * proxies requests to an origin URL, and injects a custom script into HTML responses.
   *
   * @param request - The incoming HTTP request.
   * @param env - The environment variables and bindings.
   * @param ctx - The execution context.
   * @returns A Promise resolving to the HTTP response.
   */
  async fetch(request, env, ctx): Promise<Response> {
    // Prevent infinite loops when serving assets
    if (request.headers.has('x-skip-worker')) {
      return env.ASSETS.fetch(request);
    }

    const url = new URL(request.url);
    const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;

    // Handle OAuth Routes
    if (url.pathname.startsWith(usersPath + 'auth/')) {
      return handleAuth(request, env, url, usersPath);
    }

    // Intercept requests to usersPath and serve them from the public/users directory.
    // This allows us to serve our own scripts and assets.
    if (url.pathname.startsWith(usersPath)) {
      url.pathname = url.pathname.replace(usersPath, '/users/');
      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('x-skip-worker', 'true');
      return env.ASSETS.fetch(newRequest);
    }

    if (env.ORIGIN_URL) {
      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;

      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('Host', url.host);

      const response = await fetch(newRequest);
      return injectPowerStrip(response, usersPath);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
