import { AccessPolicySchema } from '../schemas/policy';
import type { AccessPolicyConfig, AccessPolicyResolved, AccessRule, Requirement, UnauthorizedAction } from '../schemas/policy';
import type { Entitlements } from '../entitlements/types';
import { providerEntitlementCheckers, providerSupportsEntitlements } from './entitlementCheckers';

/**
 * Match a single path pattern against a request path.
 * - `/`        → the homepage only
 * - `/foo/*`   → `/foo` and anything under `/foo/`
 * - `/foo`     → exact match
 */
export function matchPattern(pattern: string, path: string): boolean {
  if (pattern === '/') return path === '/';
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return path === base || path.startsWith(base + '/');
  }
  return path === pattern;
}

export type PolicyDecision =
  | { allow: true }
  | { allow: false; reason: 'unauthenticated' | 'not_entitled'; action: UnauthorizedAction; upgrade_url?: string };

function deny(reason: 'unauthenticated' | 'not_entitled', rule: AccessRule): PolicyDecision {
  return { allow: false, reason, action: rule.on_unauthorized, upgrade_url: rule.upgrade_url };
}

/**
 * Decide whether a request satisfies a resolved rule, given the auth state and resolved entitlements.
 * `bypass`/`public` always allow; `authenticated` needs a logged-in user; `entitlement` dispatches the
 * condition through the provider checker registry.
 */
export function evaluateAccess(rule: AccessRule, ctx: { authenticated: boolean; entitlements: Entitlements | null }): PolicyDecision {
  const req = rule.requirement;
  switch (req.mode) {
    case 'bypass':
    case 'public':
      return { allow: true };
    case 'authenticated':
      return ctx.authenticated ? { allow: true } : deny('unauthenticated', rule);
    case 'entitlement': {
      if (!ctx.authenticated) return deny('unauthenticated', rule);
      const checker = providerEntitlementCheckers[req.provider];
      const ok = checker ? checker(req.condition, ctx.entitlements) : false;
      return ok ? { allow: true } : deny('not_entitled', rule);
    }
  }
}

/**
 * Static registry for the path-based access policy, initialized once at startup (mirrors the Plan
 * registry pattern). The default rule (for unmatched paths) falls back to `authenticated`.
 */
export class AccessPolicy {
  private static config: AccessPolicyResolved | null = null;

  static init(config: AccessPolicyConfig | undefined): void {
    const parsed = AccessPolicySchema.parse(config ?? {});

    // Validate that every entitlement requirement targets a provider that supports entitlements.
    const requirements: Requirement[] = [...parsed.rules.map((r) => r.requirement), ...(parsed.default ? [parsed.default] : [])];
    for (const req of requirements) {
      if (req.mode === 'entitlement' && !providerSupportsEntitlements(req.provider)) {
        throw new Error(
          `Access policy references an entitlement condition for provider '${req.provider}', which does not support entitlement conditions`,
        );
      }
    }

    AccessPolicy.config = parsed;
  }

  static isInitialized(): boolean {
    return AccessPolicy.config !== null;
  }

  /** Reset state — intended for tests that re-init with different configs. */
  static reset(): void {
    AccessPolicy.config = null;
  }

  /** Resolve the rule that applies to a path: first matching rule, else the default. */
  static evaluate(path: string): AccessRule {
    const cfg = AccessPolicy.config;
    if (!cfg) throw new Error('AccessPolicy not initialized');

    for (const rule of cfg.rules) {
      if (matchPattern(rule.pattern, path)) return rule;
    }

    return {
      pattern: '*',
      requirement: cfg.default ?? { mode: 'authenticated' },
      on_unauthorized: cfg.default_on_unauthorized,
      upgrade_url: cfg.default_upgrade_url,
    };
  }
}
