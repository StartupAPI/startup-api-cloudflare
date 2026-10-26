import { test, expect } from '@playwright/test';
import { ORIGIN } from './harness';
import { mountAdmin } from './adminHarness';

// The user and account pages of the admin dashboard, laid out like the PHP StartupAPI admin's user.php
// and account.php. The dashboard lists only link to them; every action lives on the page.

test('the dashboard lists link to the user and account pages, with no row actions', async ({ page }) => {
  await mountAdmin(page);
  await expect(page.locator('#users-table tr')).toHaveCount(2);
  await expect(page.locator('#users-table button, #accounts-table button')).toHaveCount(0);
  await expect(page.locator('#users-table a', { hasText: 'Jane Doe' })).toHaveAttribute('href', '/users/admin/users/user-1111');
  // Names are escaped, not rendered as markup.
  await expect(page.locator('#users-table a', { hasText: 'Bob <i>' })).toBeVisible();
  await page.locator('#accounts-table a', { hasText: 'Acme' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/users/admin/accounts/acct-2222`);
  await expect(page.locator('#account-title')).toContainText('Account: Acme');
});

test('a user page shows the profile, credentials and accounts', async ({ page }) => {
  await mountAdmin(page, { path: 'users/user-3333' });
  await expect(page.locator('#list-view')).toBeHidden();
  await expect(page.locator('#user-title')).toContainText('Bob <i>');
  await expect(page.locator('#user-title')).toContainText('(ID: user-3333)');
  await expect(page.locator('#user-title .label-admin')).toHaveText('system admin');
  await expect(page.locator('#user-email a')).toHaveAttribute('href', 'mailto:bob@example.test');
  await expect(page.locator('#user-registered')).toContainText('1 day ago');
  await expect(page.locator('#user-provider')).toContainText('patreon');
  await expect(page.locator('#user-credentials')).toContainText('patreon: bob@example.test');
  await expect(page.locator('#edit-user-name')).toHaveValue('Bob <i>');

  const row = page.locator('#user-accounts-table tr');
  await expect(row).toHaveCount(1);
  await expect(row.locator('a')).toHaveAttribute('href', '/users/admin/accounts/acct-2222');
  await expect(row).toContainText('user');
  await expect(row).toContainText('current');
  await expect(row.locator('.label-plan')).toHaveText('Pro');
  await expect(page).toHaveTitle('Bob <i> – Admin');
});

test('a user page saves the profile, removes a membership and impersonates', async ({ page }) => {
  const { calls } = await mountAdmin(page, { path: 'users/user-1111' });
  await page.locator('#edit-user-name').fill('Jane Q. Doe');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#toast')).toHaveText('User updated');
  expect(calls).toContain('PUT users/user-1111 {"name":"Jane Q. Doe","email":"jane@example.test"}');

  await page.locator('#user-accounts-table').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#user-accounts-table')).toContainText('Not a member of any account');
  expect(calls).toContain('DELETE accounts/acct-2222/members/user-1111');

  await page.getByRole('button', { name: 'Impersonate' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  expect(calls).toContain('POST impersonate {"userId":"user-1111"}');
});

test('deleting a user goes back to the dashboard', async ({ page }) => {
  const { calls } = await mountAdmin(page, { path: 'users/user-1111' });
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/users/admin/`);
  expect(calls).toContain('DELETE users/user-1111');
});

test('an account page shows its status, plan and users', async ({ page }) => {
  await mountAdmin(page, { path: 'accounts/acct-2222' });
  await expect(page.locator('#account-title')).toContainText('(ID: acct-2222)');
  await expect(page.locator('#account-status')).toContainText('active');
  await expect(page.locator('#account-status .label-plan')).toHaveText('Pro');
  await expect(page.locator('#account-created')).toContainText('10 days ago');
  await expect(page.locator('#edit-account-name')).toHaveValue('Acme');
  await expect(page.locator('#edit-account-plan')).toHaveValue('pro');

  const rows = page.locator('#account-members-table tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('a')).toHaveAttribute('href', '/users/admin/users/user-1111');
  await expect(rows.nth(0)).toContainText('admin');
  await expect(rows.nth(0).getByRole('button', { name: 'Make user' })).toBeVisible();
  await expect(rows.nth(1).getByRole('button', { name: 'Make admin' })).toBeVisible();
  // The add-a-user picker lists the users.
  await expect(page.locator('#add-member-user option')).toHaveCount(3);
});

test('an account page edits the account and its users', async ({ page }) => {
  const { calls } = await mountAdmin(page, { path: 'accounts/acct-2222' });
  await page.locator('#edit-account-status').selectOption('suspended');
  await page.locator('#account-view').getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#toast')).toHaveText('Account updated');
  expect(calls).toContain('PUT accounts/acct-2222 {"name":"Acme","status":"suspended","plan":"pro"}');

  const bob = page.locator('#account-members-table tr').filter({ hasText: 'Bob <i>' });
  await bob.getByRole('button', { name: 'Make admin' }).click();
  await expect(bob.getByRole('button', { name: 'Make user' })).toBeVisible();
  expect(calls).toContain('PATCH accounts/acct-2222/members/user-3333 {"role":1}');

  await bob.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#account-members-table tr')).toHaveCount(1);
  expect(calls).toContain('DELETE accounts/acct-2222/members/user-3333');

  await page.locator('#add-member-user').selectOption('user-3333');
  await page.getByRole('button', { name: 'Add' }).click();
  await expect(page.locator('#account-members-table tr')).toHaveCount(2);
  expect(calls).toContain('POST accounts/acct-2222/members {"user_id":"user-3333","role":0}');

  await page.locator('#account-view').getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/users/admin/`);
  expect(calls).toContain('DELETE accounts/acct-2222');
});

test('creating an account opens its page', async ({ page }) => {
  await mountAdmin(page);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.locator('#create-account-name').fill('New Co');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/users/admin/accounts/acct-2222`);
});

test('an unknown user says so', async ({ page }) => {
  await mountAdmin(page, { path: 'users/nobody' });
  await expect(page.locator('#user-title')).toHaveText('User not found');
});

test('an unknown account says so', async ({ page }) => {
  await mountAdmin(page, { path: 'accounts/nothing' });
  await expect(page.locator('#account-title')).toHaveText('Account not found');
});
