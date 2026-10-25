import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import { ORIGIN } from './harness';

// Feature flag management in the admin dashboard (public/users/admin/index.html), following the PHP
// StartupAPI admin: status labels, rollout counts, and per-account / per-user checkboxes that are
// disabled (and struck through when shut down or disabled) where an override can't apply. The page is
// served from disk with the worker's SSR placeholders filled in, and the admin API is mocked.

const ADMIN_PAGE = readFileSync(resolve(__dirname, '../../public/users/admin/index.html'), 'utf8');

const definition = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  enabled: true,
  rolled_out_to_all_users: false,
  emergency_shutdown: false,
  state: 'contextual',
  ...extra,
});

const FEATURES = [
  definition('reports', 'Reports', { rolled_out_to_all_users: true, state: 'on' }),
  definition('legacy', 'Legacy export', { enabled: false, state: 'off' }),
  definition('chat', 'Chat', { emergency_shutdown: true, state: 'off' }),
  definition('pro_reports', 'Pro reports'),
  definition('beta', 'Beta <b>'),
];

const USERS = [{ id: 'user-1111', name: 'Jane Doe', email: 'jane@example.test', provider: 'google', created_at: 0 }];
const ACCOUNTS = [{ id: 'acct-2222', name: 'Acme', status: 'active', plan: 'pro', member_count: 1, created_at: 0 }];

/** Serve the admin page with a mocked admin API. Overrides are kept per user/account path. */
async function mountAdmin(page: Page, { features = FEATURES } = {}) {
  const overrides = new Set<string>(['acct-2222/beta']);
  const calls: string[] = [];
  const html = ADMIN_PAGE.replace('{{ssr:plans_json}}', '[]').replace('{{ssr:providers}}', 'google');

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
    const path = url.pathname.replace('/users/admin/api/', '');
    if (url.pathname === '/users/admin/') return route.fulfill({ contentType: 'text/html', body: html });
    if (url.pathname === '/users/power-strip.js') return route.fulfill({ contentType: 'text/javascript', body: '' });
    if (path === 'features') {
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
    if (path === 'users') return route.fulfill({ json: USERS });
    if (path === 'accounts') return route.fulfill({ json: ACCOUNTS });
    const list = path.match(/^(users|accounts)\/([^/]+)\/features$/);
    if (list) return route.fulfill({ json: entityFeatures(list[1] === 'users' ? 'user' : 'account', list[2]) });
    const override = path.match(/^(?:users|accounts)\/([^/]+)\/features\/(.+)$/);
    if (override && (method === 'PUT' || method === 'DELETE')) {
      calls.push(`${method} ${override[1]}/${override[2]}`);
      if (method === 'PUT') overrides.add(`${override[1]}/${override[2]}`);
      else overrides.delete(`${override[1]}/${override[2]}`);
      return route.fulfill({ json: { success: true } });
    }
    return route.fulfill({ status: 404, body: 'Not found' });
  });

  await page.goto(`${ORIGIN}/users/admin/`);
  return { calls };
}

const featureRow = (page: Page, name: string) => page.locator('#features-table tr').filter({ has: page.getByText(name, { exact: true }) });
const item = (page: Page, name: string) =>
  page.locator('#entity-features-list .feature-item').filter({ has: page.locator('label > span', { hasText: new RegExp(`^${name}`) }) });
const checkbox = (page: Page, name: string) => item(page, name).getByRole('checkbox');

test('lists features with status labels and rollout counts', async ({ page }) => {
  await mountAdmin(page);
  await expect(page.locator('#features-section')).toBeVisible();
  await expect(page.locator('#features-table tr')).toHaveCount(5);

  await expect(featureRow(page, 'Reports').locator('.label')).toHaveText('all users');
  await expect(featureRow(page, 'Reports').getByRole('checkbox')).toBeChecked();
  await expect(featureRow(page, 'Legacy export').locator('.label')).toHaveText('off');
  await expect(featureRow(page, 'Legacy export')).toHaveClass(/feature-disabled/);
  await expect(featureRow(page, 'Chat').locator('.label')).toHaveText('down');
  await expect(featureRow(page, 'Pro reports').locator('.label')).toHaveText('on');
  await expect(featureRow(page, 'Pro reports').getByRole('checkbox')).not.toBeChecked();
  // One account override out of 8 accounts; names are escaped, not rendered as markup.
  await expect(featureRow(page, 'Beta <b>')).toContainText('1 accounts (12.5%)');
  await expect(featureRow(page, 'Beta <b>')).toContainText('0 users (0%)');
});

test('account features: plan-granted and global features are locked, overrides are saved together', async ({ page }) => {
  const { calls } = await mountAdmin(page);
  await page.locator('#accounts-table button', { hasText: 'Features' }).click();
  await expect(page.locator('#entity-features-modal')).toBeVisible();

  await expect(checkbox(page, 'Reports')).toBeChecked();
  await expect(checkbox(page, 'Reports')).toBeDisabled();
  await expect(item(page, 'Reports')).toContainText('(Rolled out to all users)');

  await expect(item(page, 'Legacy export')).toHaveClass(/disabled/);
  await expect(item(page, 'Legacy export')).toHaveAttribute('title', 'Feature is disabled');
  await expect(item(page, 'Legacy export')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(checkbox(page, 'Legacy export')).toBeDisabled();

  await expect(item(page, 'Chat')).toHaveClass(/shut-down/);
  await expect(item(page, 'Chat')).toHaveAttribute('title', 'Feature is shut down due to emergency');
  await expect(checkbox(page, 'Chat')).toBeDisabled();

  await expect(checkbox(page, 'Pro reports')).toBeChecked();
  await expect(checkbox(page, 'Pro reports')).toBeDisabled();
  await expect(item(page, 'Pro reports')).toContainText('(Enabled by subscription plan: Pro)');

  // Beta has an account override: editable and checked. Nothing is sent until "Update features".
  await expect(checkbox(page, 'Beta <b>')).toBeChecked();
  await checkbox(page, 'Beta <b>').uncheck();
  expect(calls).toEqual([]);
  await page.getByRole('button', { name: 'Update features' }).click();
  await expect(checkbox(page, 'Beta <b>')).not.toBeChecked();
  expect(calls).toEqual(['DELETE acct-2222/beta']);
});

test('user features: inheritance is shown as a note, not a checked box', async ({ page }) => {
  const { calls } = await mountAdmin(page);
  await page.locator('#users-table button', { hasText: 'Features' }).click();
  await expect(page.locator('#entity-features-help')).toContainText('control features on the account level');

  await expect(checkbox(page, 'Pro reports')).not.toBeChecked();
  await expect(checkbox(page, 'Pro reports')).toBeEnabled();
  await expect(item(page, 'Pro reports')).toContainText('(Enabled in accounts: Acme)');

  await checkbox(page, 'Beta <b>').check();
  await page.getByRole('button', { name: 'Update features' }).click();
  await expect(checkbox(page, 'Beta <b>')).toBeChecked();
  await expect(featureRow(page, 'Beta <b>')).toContainText('1 users (25%)');
  expect(calls).toEqual(['PUT user-1111/beta']);
});

test('disables "Update features" when no feature can be overridden', async ({ page }) => {
  await mountAdmin(page, { features: FEATURES.slice(0, 3) });
  await page.locator('#users-table button', { hasText: 'Features' }).click();
  await expect(page.getByRole('button', { name: 'Update features' })).toBeDisabled();
});

test('hides feature management when no features are configured', async ({ page }) => {
  await mountAdmin(page, { features: [] });
  await expect(page.locator('#users-table tr')).toHaveCount(1);
  await expect(page.locator('#features-section')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Features' })).toHaveCount(0);
});
