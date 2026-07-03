import { handleAuth } from './auth/index';
import { injectPowerStrip } from './PowerStrip';
import { UserDO } from './storage/UserDO';
import { AccountDO } from './storage/AccountDO';
import { SystemDO } from './storage/SystemDO';
import { CredentialDO } from './storage/CredentialDO';
import { CookieManager } from './CookieManager';
import { initPlans } from './billing/plansConfig';
import { Plan } from './billing/Plan';
import { getActiveProviders, parseCookies, getUserFromSession, isAdmin, applySessionRenewal, sessionSetCookie } from './handlers/utils';
import { handleAdmin } from './handlers/admin';
import {
  handleMe,
  handleUpdateProfile,
  handleListCredentials,
  handleDeleteCredential,
  handleMeImage,
  handleUserImage,
} from './handlers/user';
import { handleMyAccounts, handleSwitchAccount, handleAccountDetails, handleAccountImage, handleAccountMembers } from './handlers/account';
import { handleLogout } from './handlers/auth';
import { handleSSR } from './handlers/ssr';

import type { StartupAPIEnv } from './StartupAPIEnv';
import { StartupAPIConfigSchema, DEFAULT_SESSION_TTL_MS } from './schemas/config';
import type { StartupAPIConfig, ProviderOptions, ResolvedFreshness } from './schemas/config';
import type { AccessPolicyConfig, PageSource } from './schemas/policy';
import { AccessPolicy, evaluateAccess } from './policy/accessPolicy';
import type { PolicyDecision } from './policy/accessPolicy';
import { loadEntitlements, entitlementHeaders } from './entitlements/service';
import type { Entitlements } from './entitlements/types';
import { computeRedirectBase, getProvider } from './auth/providers';
import { runEntitlementResync } from './entitlements/cron';
import { handlePatreonWebhook } from './webhooks/patreon';

const DEFAULT_USERS_PATH = '/users/';
const DEFAULT_CRON_SCHEDULE = '0 */6 * * *';
const DEFAULT_ENTITLEMENT_TTL_MS = 15 * 60 * 1000;
// Patreon memberships change slowly (pledges are monthly) and real-time changes are already covered by
// the webhook, so a per-request re-check every 15 min is wasteful. Default Patreon's TTL to 1 day; it
// acts as a backstop for missed webhooks rather than the primary freshness mechanism.
const DEFAULT_PATREON_ENTITLEMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** Provider-specific default entitlement TTL, used when a provider enables `ttl` without an explicit `ms`. */
function defaultEntitlementTtlMs(providerName?: string): number {
  return providerName === 'patreon' ? DEFAULT_PATREON_ENTITLEMENT_TTL_MS : DEFAULT_ENTITLEMENT_TTL_MS;
}

// The factory's request handler is a local `const fetch`, which would shadow the global fetch inside
// its body. Use this alias to proxy to the origin via the *current* global fetch at call time (so test
// spies on globalThis.fetch are honored).
const originFetch = (...args: Parameters<typeof fetch>): Promise<Response> => globalThis.fetch(...args);

function isCronEnabled(options: ProviderOptions): boolean {
  const cron = options.freshness?.cron;
  return cron === true || (typeof cron === 'object' && cron !== null);
}

/** Resolve a provider's freshness config into concrete flags/values. */
function resolveFreshness(options: ProviderOptions | undefined, providerName?: string): ResolvedFreshness {
  const f = options?.freshness ?? {};
  const ttlEnabled = f.ttl === true || (typeof f.ttl === 'object' && f.ttl !== null);
  const ttlMs = typeof f.ttl === 'object' && f.ttl?.ms ? f.ttl.ms : defaultEntitlementTtlMs(providerName);
  const cronEnabled = isCronEnabled(options ?? {});
  const cronSchedule = typeof f.cron === 'object' && f.cron?.schedule ? f.cron.schedule : DEFAULT_CRON_SCHEDULE;
  return {
    ttl: { enabled: ttlEnabled, ms: ttlMs },
    cron: { enabled: cronEnabled, schedule: cronSchedule },
    webhook: { enabled: f.webhook === true },
  };
}

/** Resolve the login session lifetime (rolling window, ms) from factory config, else the 30-day default. */
function resolveSessionTtlMs(session: StartupAPIConfig['session']): number {
  const ttl = session?.ttl;
  if (typeof ttl === 'object' && ttl?.ms) return ttl.ms;
  return DEFAULT_SESSION_TTL_MS;
}

/** Resolve the access policy from factory config, else a backward-compatible all-public default. */
function resolveAccessPolicy(configPolicy: AccessPolicyConfig | undefined): AccessPolicyConfig {
  // No policy configured → preserve legacy behavior: allow everything, still forward identity headers.
  return configPolicy ?? { default: { mode: 'public' } };
}

/**
 * Serve a gate page body in place (no redirect), sourced from either the ASSETS binding (a local file)
 * or a path proxied from ORIGIN_URL. The configured status is re-stamped onto the response so e.g. a
 * 200 asset can be served as a 403 gate.
 */
async function serveGatePage(
  source: PageSource,
  status: number,
  request: Request,
  env: StartupAPIEnv,
  reqUrl: URL,
): Promise<Response> {
  let res: Response;
  if ('asset' in source) {
    // Serve a local file from ASSETS, mirroring the existing user-asset path.
    const assetReq = new Request(new URL(source.asset, reqUrl).toString(), { method: 'GET' });
    assetReq.headers.set('x-skip-worker', 'true');
    res = await env.ASSETS.fetch(assetReq);
  } else {
    // Proxy a path from ORIGIN_URL (swap host, set Host), like the main origin proxy.
    const target = new URL(source.origin, new URL(env.ORIGIN_URL));
    const proxied = new Request(target.toString(), request);
    proxied.headers.set('Host', target.host);
    res = await originFetch(proxied);
  }
  // Re-stamp the status (e.g. a 200 asset can be served as the configured gate status).
  return new Response(res.body, { status, headers: res.headers });
}

/** Build a deny response (login redirect / 403 / upgrade redirect / in-place gate page) for an unmet access requirement. */
function denyResponse(
  decision: Extract<PolicyDecision, { allow: false }>,
  ctx: { usersPath: string; returnUrl: string; activeProviders: string[]; authenticated: boolean; request: Request; env: StartupAPIEnv; url: URL },
): Response | Promise<Response> {
  if (decision.action === 'gate' && decision.gate) {
    // Serve an explainer page in place: anonymous variant for logged-out visitors, unentitled variant
    // (falling back to anonymous) for logged-in visitors who fail the requirement. No redirect.
    const source = ctx.authenticated ? (decision.gate.unentitled ?? decision.gate.anonymous) : decision.gate.anonymous;
    return serveGatePage(source, decision.gate.status ?? 200, ctx.request, ctx.env, ctx.url);
  }
  if (decision.action === 'forbidden') {
    return new Response('Forbidden', { status: 403 });
  }
  if (decision.action === 'upgrade' && decision.upgrade_url) {
    return new Response(null, { status: 302, headers: { Location: decision.upgrade_url } });
  }
  // 'login' (default): send the user to authenticate, preserving where they were going.
  const ret = encodeURIComponent(ctx.returnUrl);
  const target =
    ctx.activeProviders.length === 1 ? `${ctx.usersPath}auth/${ctx.activeProviders[0]}?return_url=${ret}` : `/?return_url=${ret}`;
  return new Response(null, { status: 302, headers: { Location: target } });
}

/**
 * Build a configured StartupAPI instance: the Worker handler ({ fetch, scheduled? }) plus the Durable
 * Object classes for re-export. `scheduled` is attached ONLY when at least one provider enables cron.
 *
 * All config is optional and falls back to env-derived defaults, so `createStartupAPI()` behaves like
 * the previous package (login-only entitlements, no scheduled handler, all-public access policy).
 */
export function createStartupAPI(config: StartupAPIConfig = {}) {
  const parsed = StartupAPIConfigSchema.parse(config);
  const providerConfigs = parsed.providers ?? {};
  const sessionTtlMs = resolveSessionTtlMs(parsed.session);
  const cronProviders = Object.entries(providerConfigs)
    .filter(([, options]) => isCronEnabled(options))
    .map(([name]) => name);
  const anyCron = cronProviders.length > 0;
  const patreonWebhookEnabled = providerConfigs.patreon?.freshness?.webhook === true;

  const fetch = async (request: Request, env: StartupAPIEnv, ctx: ExecutionContext): Promise<Response> => {
    if (!Plan.isInitialized()) {
      if (parsed.plans) Plan.init(parsed.plans as any);
      else initPlans();
    }
    if (!AccessPolicy.isInitialized()) {
      AccessPolicy.init(resolveAccessPolicy(parsed.accessPolicy));
    }

    // Prevent infinite loops when serving assets
    if (request.headers.has('x-skip-worker')) {
      return env.ASSETS.fetch(request);
    }

    if (!env.ORIGIN_URL || !env.SESSION_SECRET) {
      return env.ASSETS.fetch(request);
    }

    const url = new URL(request.url);
    const usersPath = env.USERS_PATH || DEFAULT_USERS_PATH;

    const cookieManager = new CookieManager(env.SESSION_SECRET);

    // SSR Routes
    const usersPathNormalized = usersPath.endsWith('/') ? usersPath : usersPath + '/';
    if (url.pathname.startsWith(usersPathNormalized)) {
      const subPath = url.pathname.slice(usersPathNormalized.length);
      const isProfile = subPath === 'profile.html' || subPath === 'profile';
      const isAccounts = subPath === 'accounts.html' || subPath === 'accounts';

      if (isProfile || isAccounts) {
        return handleSSR(request, env, url, usersPath, cookieManager, providerConfigs);
      }
    }

    // Patreon webhook (only mounted when configured)
    if (patreonWebhookEnabled && url.pathname === usersPath + 'webhooks/patreon') {
      return handlePatreonWebhook(request, env, ctx, providerConfigs);
    }

    // Handle OAuth Routes
    if (url.pathname.startsWith(usersPath + 'auth/')) {
      return handleAuth(request, env, url, usersPath, cookieManager, providerConfigs, sessionTtlMs);
    }

    if (url.pathname === usersPath + 'me/avatar') {
      return handleMeImage(request, env, 'avatar', cookieManager);
    }

    // Handle API Routes
    if (url.pathname.startsWith(usersPath + 'api/')) {
      const apiPath = url.pathname.replace(usersPath + 'api/', '/');

      if (apiPath === '/me') {
        return handleMe(request, env, cookieManager);
      }

      if (apiPath === '/me/profile' && request.method === 'POST') {
        return handleUpdateProfile(request, env, cookieManager);
      }

      if (apiPath === '/me/credentials') {
        if (request.method === 'GET') {
          return handleListCredentials(request, env, cookieManager);
        } else if (request.method === 'DELETE') {
          return handleDeleteCredential(request, env, cookieManager);
        }
      }

      if (apiPath === '/stop-impersonation' && request.method === 'POST') {
        const cookieHeader = request.headers.get('Cookie');
        const cookies = parseCookies(cookieHeader || '');
        const backupSessionEncrypted = cookies['backup_session_id'];

        if (!backupSessionEncrypted) {
          return new Response('No impersonation session found', { status: 400 });
        }

        const backupSession = await cookieManager.decrypt(backupSessionEncrypted);
        if (!backupSession) {
          return new Response('Invalid backup session', { status: 400 });
        }

        const headers = new Headers();
        const newSessionIdEncrypted = await cookieManager.encrypt(backupSession);
        headers.set('Set-Cookie', sessionSetCookie(newSessionIdEncrypted, Math.floor(sessionTtlMs / 1000)));
        headers.append('Set-Cookie', `backup_session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

        return Response.json({ success: true }, { headers });
      }

      if (apiPath === '/me/accounts') {
        return handleMyAccounts(request, env, cookieManager);
      }

      if (apiPath === '/me/accounts/switch' && request.method === 'POST') {
        return handleSwitchAccount(request, env, cookieManager);
      }

      if (apiPath.startsWith('/me/accounts/')) {
        const parts = apiPath.split('/');
        if (parts.length === 4) {
          return handleAccountDetails(request, env, parts[3], cookieManager);
        }
        if (parts.length === 5 && parts[4] === 'avatar') {
          return handleAccountImage(request, env, parts[3], 'avatar', cookieManager);
        }
        if (parts.length >= 5 && parts[4] === 'members') {
          return handleAccountMembers(request, env, parts[3], parts.slice(5), cookieManager);
        }
      }

      if (apiPath.startsWith('/users/')) {
        const parts = apiPath.split('/');
        if (parts.length === 4 && parts[3] === 'avatar') {
          return handleUserImage(request, env, parts[2], 'avatar', cookieManager);
        }
      }
    }

    if (url.pathname === usersPath + 'logout') {
      return handleLogout(request, env, url, usersPath, cookieManager);
    }

    // Admin Routes
    if (url.pathname.startsWith(usersPath + 'admin/')) {
      return handleAdmin(request, env, usersPath, cookieManager, providerConfigs, sessionTtlMs);
    }

    // Intercept requests to usersPath and serve them from the public/users directory.
    if (url.pathname.startsWith(usersPath)) {
      url.pathname = url.pathname.replace(usersPath, '/users/');
      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('x-skip-worker', 'true');
      return env.ASSETS.fetch(newRequest);
    }

    if (env.ORIGIN_URL) {
      // Evaluate the access policy BEFORE any identity work, so bypass paths are a raw proxy.
      const rule = AccessPolicy.evaluate(url.pathname);
      const requestOrigin = env.AUTH_ORIGIN && env.AUTH_ORIGIN !== '' ? env.AUTH_ORIGIN : url.origin;
      const returnUrl = url.pathname + url.search;

      const originUrl = new URL(env.ORIGIN_URL);
      url.protocol = originUrl.protocol;
      url.host = originUrl.host;
      url.port = originUrl.port;

      const newRequest = new Request(url.toString(), request);
      newRequest.headers.set('Host', url.host);

      if (rule.requirement.mode === 'bypass') {
        // Pure pass-through: no identity resolution, no headers, no power-strip injection.
        return originFetch(newRequest);
      }

      const user = await getUserFromSession(request, env, cookieManager, sessionTtlMs);
      const authenticated = !!user;
      const userIsAdmin = user ? isAdmin(user, env) : false;
      let entitlements: Entitlements | null = null;
      let loginProvider: string | undefined;

      if (user) {
        newRequest.headers.set('X-StartupAPI-User-Id', user.id);
        const userStub = env.USER.get(env.USER.idFromString(user.id));
        const currentAccount = await userStub.getCurrentAccount();
        if (currentAccount) {
          newRequest.headers.set('X-StartupAPI-Account-Id', currentAccount.account_id);
        }

        loginProvider = user.credential?.provider;
        const subjectId = user.credential?.subject_id;
        if (loginProvider && subjectId) {
          const provider = getProvider(env, computeRedirectBase(env, requestOrigin, usersPath), loginProvider, providerConfigs);
          if (provider && provider.supportsEntitlements()) {
            const fr = resolveFreshness(providerConfigs[loginProvider], loginProvider);
            entitlements = await loadEntitlements({
              env,
              provider,
              userStub,
              userId: user.id,
              subjectId,
              ttlEnabled: fr.ttl.enabled,
              ttlMs: fr.ttl.ms,
            });
          }
        }
      }

      // Forward login + entitlement info to the origin (skipped for bypass above).
      for (const [key, value] of Object.entries(entitlementHeaders(authenticated, loginProvider, entitlements))) {
        newRequest.headers.set(key, value);
      }

      // Enforce the requirement. Admins bypass the gate (identity/headers above still apply).
      const decision = evaluateAccess(rule, { authenticated, entitlements, isAdmin: userIsAdmin });
      if (!decision.allow) {
        return denyResponse(decision, {
          usersPath,
          returnUrl,
          activeProviders: getActiveProviders(env, providerConfigs),
          authenticated,
          request,
          env,
          url,
        });
      }

      const response = await originFetch(newRequest);
      const providers = getActiveProviders(env, providerConfigs);
      // Refresh the persistent session cookie's Max-Age when the DO extended the session (sliding renewal).
      const decorated = await injectPowerStrip(response, usersPath, providers);
      return applySessionRenewal(decorated, user?.renew);
    }

    // do not modify the request as it will loop through the same worker again
    return env.ASSETS.fetch(request);
  };

  const handler: ExportedHandler<StartupAPIEnv> = { fetch };

  if (anyCron) {
    handler.scheduled = async (_event: ScheduledController, env: StartupAPIEnv, ctx: ExecutionContext): Promise<void> => {
      ctx.waitUntil(runEntitlementResync(env, cronProviders, providerConfigs));
    };
  }

  return { default: handler, fetch: handler.fetch!, scheduled: handler.scheduled, UserDO, AccountDO, SystemDO, CredentialDO };
}
