import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';
import { ORIGIN } from './harness';

// The admin dashboard (public/users/admin/index.html), served from disk with the worker's SSR
// placeholders filled in and the admin API mocked. The same page serves the dashboard
// (/users/admin/) and the user and account pages (/users/admin/users/<id>, /users/admin/accounts/<id>).

const ADMIN_PAGE = readFileSync(resolve(__dirname, '../../public/users/admin/index.html'), 'utf8');

export const definition = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  enabled: true,
  rolled_out_to_all_users: false,
  emergency_shutdown: false,
  state: 'contextual',
  ...extra,
});

export const FEATURES = [
  definition('reports', 'Reports', { rolled_out_to_all_users: true, state: 'on' }),
  definition('legacy', 'Legacy export', { enabled: false, state: 'off' }),
  definition('chat', 'Chat', { emergency_shutdown: true, state: 'off' }),
  definition('pro_reports', 'Pro reports'),
  definition('beta', 'Beta <b>'),
];

export const PLANS = [
  { slug: 'free', name: 'Free' },
  { slug: 'pro', name: 'Pro' },
];

const DAY = 86_400_000;

export const USERS = [
  { id: 'user-1111', name: 'Jane Doe', email: 'jane@example.test', provider: 'google', created_at: Date.now() - 3 * DAY, is_admin: false },
  { id: 'user-3333', name: 'Bob <i>', email: 'bob@example.test', provider: 'patreon', created_at: Date.now() - DAY, is_admin: true },
];
export const ACCOUNTS = [
  { id: 'acct-2222', name: 'Acme', status: 'active', plan: 'pro', member_count: 2, created_at: Date.now() - 10 * DAY },
];

export interface MountOptions {
  features?: typeof FEATURES;
  /** The admin path to open, e.g. `users/user-1111`. */
  path?: string;
}

/** Serve the admin page with a mocked admin API. State (overrides, members) is kept per mount. */
export async function mountAdmin(page: Page, { features = FEATURES, path = '' }: MountOptions = {}) {
  const overrides = new Set<string>(['acct-2222/beta']);
  const members = new Map<string, { user_id: string; role: number; joined_at: number }>([
    ['user-1111', { user_id: 'user-1111', role: 1, joined_at: Date.now() - 2 * DAY }],
    ['user-3333', { user_id: 'user-3333', role: 0, joined_at: Date.now() - DAY }],
  ]);
  const calls: string[] = [];
  const html = ADMIN_PAGE.replace('{{ssr:plans_json}}', JSON.stringify(PLANS).replace(/"/g, '&quot;')).replace(
    '{{ssr:providers}}',
    'google',
  );

  const entityFeatures = (kind: 'user' | 'account', id: string) =>
    features.map((f) => {
      const override = overrides.has(`${id}/${f.id}`);
      const plan = kind === 'account' && f.id === 'pro_reports' ? { slug: 'pro', name: 'Pro' } : null;
      return {
        ...f,
        active: f.state === 'on' || (f.state === 'contextual' && (override || !!plan)),
        override,
        ...(kind === 'account' ? { plan } : { accounts: f.id === 'pro_reports' ? [{ id: 'acct-2222', name: 'Acme' }] : [] }),
      };
    });

  await page.route(`${ORIGIN}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const apiPath = url.pathname.replace('/users/admin/api/', '');
    if (url.pathname === '/users/admin/' || /^\/users\/admin\/(users|accounts)\/[^/]+$/.test(url.pathname)) {
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (url.pathname === '/users/power-strip.js') return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: 'home' });
    if (!url.pathname.startsWith('/users/admin/api/')) return route.fulfill({ status: 404, body: 'Not found' });

    if (method !== 'GET') calls.push(`${method} ${apiPath}${route.request().postData() ? ' ' + route.request().postData() : ''}`);

    if (apiPath === 'features') {
      const count = (suffix: string, f: { id: string }) =>
        [...overrides].filter((o) => o.startsWith(suffix) && o.endsWith(`/${f.id}`)).length;
      return route.fulfill({
        json: {
          total_users: 4,
          total_accounts: 8,
          features: features.map((f) => ({ ...f, user_count: count('user-', f), account_count: count('acct-', f) })),
        },
      });
    }
    if (apiPath === 'users') return route.fulfill({ json: USERS });
    if (apiPath === 'accounts') return route.fulfill({ json: method === 'POST' ? { success: true, id: 'acct-2222' } : ACCOUNTS });
    if (apiPath === 'impersonate') return route.fulfill({ json: { success: true } });

    const user = apiPath.match(/^users\/([^/]+)$/);
    if (user) {
      const found = USERS.find((u) => u.id === user[1]);
      if (!found) return route.fulfill({ status: 404, body: 'Not Found' });
      if (method === 'GET') {
        return route.fulfill({
          json: {
            ...found,
            credentials: [{ provider: found.provider, subject_id: 's-1', email: found.email, created_at: found.created_at }],
          },
        });
      }
      return route.fulfill({ json: { success: true } });
    }
    const memberships = apiPath.match(/^users\/([^/]+)\/memberships$/);
    if (memberships) {
      return route.fulfill({
        json: members.has(memberships[1])
          ? [{ account_id: 'acct-2222', role: members.get(memberships[1])!.role, is_current: 1, account: ACCOUNTS[0] }]
          : [],
      });
    }
    const account = apiPath.match(/^accounts\/([^/]+)$/);
    if (account) {
      const found = ACCOUNTS.find((a) => a.id === account[1]);
      if (!found) return route.fulfill({ status: 404, body: 'Not Found' });
      return route.fulfill({ json: method === 'GET' ? found : { success: true } });
    }
    const memberList = apiPath.match(/^accounts\/([^/]+)\/members$/);
    if (memberList) {
      if (method === 'POST') {
        const { user_id, role } = route.request().postDataJSON();
        members.set(user_id, { user_id, role, joined_at: Date.now() });
        return route.fulfill({ json: { success: true } });
      }
      return route.fulfill({ json: [...members.values()].map((m) => ({ ...m, user: USERS.find((u) => u.id === m.user_id) ?? null })) });
    }
    const member = apiPath.match(/^accounts\/([^/]+)\/members\/([^/]+)$/);
    if (member) {
      if (method === 'DELETE') members.delete(member[2]);
      if (method === 'PATCH') members.get(member[2])!.role = route.request().postDataJSON().role;
      return route.fulfill({ json: { success: true } });
    }
    const list = apiPath.match(/^(users|accounts)\/([^/]+)\/features$/);
    if (list) return route.fulfill({ json: entityFeatures(list[1] === 'users' ? 'user' : 'account', list[2]) });
    const override = apiPath.match(/^(?:users|accounts)\/([^/]+)\/features\/(.+)$/);
    if (override && (method === 'PUT' || method === 'DELETE')) {
      if (method === 'PUT') overrides.add(`${override[1]}/${override[2]}`);
      else overrides.delete(`${override[1]}/${override[2]}`);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });

  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(`${ORIGIN}/users/admin/${path}`);
  return { calls };
}
