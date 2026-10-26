import { test, expect, type Page } from '@playwright/test';
import { FEATURES, mountAdmin } from './adminHarness';

// Feature flag management in the admin dashboard, following the PHP StartupAPI admin: status labels and
// rollout counts on the dashboard, and per-account / per-user checkboxes on their pages that are
// disabled (and struck through when shut down or disabled) where an override can't apply.

const featureRow = (page: Page, name: string) => page.locator('#features-table tr').filter({ has: page.getByText(name, { exact: true }) });
const item = (page: Page, name: string) =>
  page.locator('.feature-item:visible').filter({ has: page.locator('label > span', { hasText: new RegExp(`^${name}`) }) });
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
  const { calls } = await mountAdmin(page, { path: 'accounts/acct-2222' });
  await expect(page.locator('#account-features-section')).toBeVisible();

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
  expect(calls).toEqual(['DELETE accounts/acct-2222/features/beta']);
});

test('user features: inheritance is shown as a note, not a checked box', async ({ page }) => {
  const { calls } = await mountAdmin(page, { path: 'users/user-1111' });
  await expect(page.locator('#user-features-section')).toContainText('control features on the account level');

  await expect(checkbox(page, 'Pro reports')).not.toBeChecked();
  await expect(checkbox(page, 'Pro reports')).toBeEnabled();
  await expect(item(page, 'Pro reports')).toContainText('(Enabled in accounts: Acme)');

  await checkbox(page, 'Beta <b>').check();
  await page.getByRole('button', { name: 'Update features' }).click();
  await expect(checkbox(page, 'Beta <b>')).toBeChecked();
  expect(calls).toEqual(['PUT users/user-1111/features/beta']);
});

test('disables "Update features" when no feature can be overridden', async ({ page }) => {
  await mountAdmin(page, { features: FEATURES.slice(0, 3), path: 'users/user-1111' });
  await expect(page.locator('#user-features-section').getByRole('button', { name: 'Update features' })).toBeDisabled();
});

test('hides feature management when no features are configured', async ({ page }) => {
  await mountAdmin(page, { features: [] });
  await expect(page.locator('#users-table tr')).toHaveCount(2);
  await expect(page.locator('#features-section')).toBeHidden();
});

test('hides the features section on a user page when no features are configured', async ({ page }) => {
  await mountAdmin(page, { features: [], path: 'users/user-1111' });
  await expect(page.locator('#user-credentials li')).toHaveCount(1);
  await expect(page.locator('#user-features-section')).toBeHidden();
});
