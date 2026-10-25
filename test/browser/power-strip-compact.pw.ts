import { test, expect, type Page } from '@playwright/test';
import { CACHE_KEY, ORIGIN, mount, ready, signedIn } from './harness';

// The compact variant (variant="compact"): an account control for a host's own
// header. Locators pierce the component's open shadow root.

const login = (page: Page) => page.locator('power-strip [part~="login"]');
const avatarButton = (page: Page) => page.locator('power-strip [part~="avatar-button"]');
const menu = (page: Page) => page.locator('power-strip [part~="menu"]');
const menuItems = (page: Page) => page.locator('power-strip [role^="menuitem"]');

const cache = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), CACHE_KEY);

test.describe('signed out', () => {
  test('one provider: a "Log in" link straight to it, back to this page', async ({ page }) => {
    await mount(page, { me: null });
    await expect(login(page)).toBeVisible();
    await expect(login(page)).toHaveText('Log in');
    await expect(login(page)).toHaveAttribute('aria-label', 'Log in');
    await expect(login(page)).toHaveAttribute('title', 'Log in with Patreon');
    expect(await login(page).evaluate((el) => el.tagName)).toBe('A');
    await expect(login(page)).toHaveAttribute('href', `/users/auth/patreon?return_url=${encodeURIComponent(`${ORIGIN}/`)}`);

    // The page changes its URL after load: the link follows it on click.
    await page.evaluate(() => history.pushState(null, '', '/projects/42?x=1'));
    const auth = page.waitForRequest((r) => r.url().includes('/users/auth/patreon'));
    await login(page).click();
    const url = new URL((await auth).url());
    expect(url.searchParams.get('return_url')).toBe(`${ORIGIN}/projects/42?x=1`);
  });

  test('several providers: "Log in" opens the provider dialog', async ({ page }) => {
    await mount(page, {
      me: null,
      element: '<power-strip variant="compact" providers="google,patreon"></power-strip>',
    });
    expect(await login(page).evaluate((el) => el.tagName)).toBe('BUTTON');
    await login(page).click();
    const dialog = page.locator('power-strip #login-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.auth-btn')).toHaveCount(2);
    await dialog.locator('#close-dialog').click();
    await expect(dialog).toBeHidden();
  });

  test('hiding the label leaves a circle the size of the avatar', async ({ page }) => {
    await mount(page, { me: null, css: 'power-strip::part(login-label) { display: none; }' });
    await expect(login(page)).toBeVisible();
    const box = (await login(page).boundingBox())!;
    expect(box.width).toBeCloseTo(32, 0);
    expect(box.height).toBeCloseTo(32, 0);
    await expect(login(page)).toHaveAttribute('aria-label', 'Log in');
  });

  test('no providers: nothing to show', async ({ page }) => {
    await mount(page, { me: null, element: '<power-strip variant="compact" providers=""></power-strip>' });
    await ready(page);
    await expect(login(page)).toHaveCount(0);
    await expect(avatarButton(page)).toHaveCount(0);
  });
});

test.describe('signed in', () => {
  test('an avatar with initials opens the account menu, Log out last', async ({ page }) => {
    await mount(page);
    await expect(avatarButton(page)).toBeVisible();
    await expect(avatarButton(page)).toHaveAttribute('aria-label', 'Account: Jane Doe');
    await expect(avatarButton(page).locator('.initials')).toHaveText('JD');
    const box = (await avatarButton(page).boundingBox())!;
    expect(box.width).toBeCloseTo(32, 0);

    await avatarButton(page).click();
    await expect(menu(page)).toBeVisible();
    await expect(avatarButton(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(menu(page).locator('.menu-name')).toHaveText('Jane Doe');
    await expect(menu(page).locator('.menu-email')).toHaveText('jane@example.test');
    await expect(menuItems(page)).toHaveText(['Account settings', 'Profile', 'Log out']);
    await expect(menuItems(page).last()).toHaveAttribute('href', `/users/logout?return_url=${encodeURIComponent(`${ORIGIN}/`)}`);

    // Right-aligned just under the avatar.
    const m = (await menu(page).boundingBox())!;
    expect(Math.abs(m.x + m.width - (box.x + box.width))).toBeLessThan(2);
    expect(m.y).toBeGreaterThanOrEqual(box.y + box.height);
    expect(m.y).toBeLessThan(box.y + box.height + 12);
  });

  test('a picture replaces the initials', async ({ page }) => {
    await mount(page, { me: signedIn({ picture: '/users/me/avatar' }) });
    const img = avatarButton(page).locator('img');
    await expect(img).toHaveAttribute('src', '/users/me/avatar');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1);
  });

  test('a picture that fails to load falls back to the initials', async ({ page }) => {
    await mount(page, { me: signedIn({ picture: '/users/missing.png' }) });
    await expect(avatarButton(page).locator('img')).toHaveCount(0);
    await expect(avatarButton(page).locator('.initials')).toHaveText('JD');
  });

  test('admins and impersonators get their items; a plain member has no Account settings', async ({ page }) => {
    await mount(page, {
      me: signedIn({ is_admin: true, is_impersonated: true }),
      accounts: [{ account_id: 'a1', name: 'Jane Doe', role: 0, is_current: 1 }],
    });
    await expect(avatarButton(page)).toHaveAttribute('data-impersonated', '');
    await avatarButton(page).click();
    // Admins may open account settings whatever their role.
    await expect(menuItems(page)).toHaveText(['Account settings', 'Profile', 'Admin', 'Stop impersonating', 'Log out']);
  });

  test('a member without the admin role sees no Account settings', async ({ page }) => {
    await mount(page, { accounts: [{ account_id: 'a1', name: 'Team', role: 0, is_current: 1 }] });
    await avatarButton(page).click();
    await expect(menuItems(page)).toHaveText(['Profile', 'Log out']);
  });

  test('with several accounts the menu switches between them', async ({ page }) => {
    const { switched } = await mount(page, {
      accounts: [
        { account_id: 'a1', name: 'Personal', role: 1, is_current: 1 },
        { account_id: 'a2', name: 'Workshop', role: 1, is_current: 0 },
      ],
    });
    await avatarButton(page).click();
    const accounts = menu(page).locator('[role="menuitemradio"]');
    await expect(accounts).toHaveText(['Personal', 'Workshop']);
    await expect(accounts.first()).toHaveAttribute('aria-checked', 'true');
    await expect(accounts.last()).toHaveAttribute('aria-checked', 'false');
    const reload = page.waitForEvent('load');
    await accounts.last().click();
    await reload;
    expect(switched).toEqual([{ account_id: 'a2' }]);
  });

  test('keyboard: Enter opens on the first item, arrows move, Escape returns to the avatar', async ({ page }) => {
    await mount(page);
    await avatarButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menuItems(page).nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(menuItems(page).last()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(avatarButton(page)).toBeFocused();
    await expect(avatarButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('clicking outside closes the menu', async ({ page }) => {
    await mount(page);
    await avatarButton(page).click();
    await expect(menu(page)).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(menu(page)).toBeHidden();
  });

  test('Log out remembers the visitor as signed out', async ({ page }) => {
    await mount(page);
    await ready(page);
    expect((await cache(page)).state).toBe('signed-in');
    await avatarButton(page).click();
    const logout = page.waitForRequest((r) => r.url().includes('/users/logout'));
    await menuItems(page).last().click();
    await logout;
    expect(await cache(page)).toEqual({ state: 'signed-out' });
  });
});

test.describe('first paint', () => {
  test("the proxy's signed-out hint shows the pill before the server answers", async ({ page }) => {
    const { release } = await mount(page, {
      holdMe: true,
      me: signedIn(),
      element: '<power-strip variant="compact" providers="patreon" auth-state="signed-out"></power-strip>',
    });
    await expect(login(page)).toBeVisible();
    // The server knows better (a session that started meanwhile): it wins.
    release();
    await expect(avatarButton(page)).toBeVisible();
  });

  test('a signed-in hint with nothing remembered shows a person glyph the size of the avatar', async ({ page }) => {
    const { release } = await mount(page, {
      holdMe: true,
      element: '<power-strip variant="compact" providers="patreon" auth-state="signed-in"></power-strip>',
    });
    await expect(avatarButton(page)).toBeVisible();
    await expect(avatarButton(page).locator('[part~="avatar"]')).toHaveAttribute('data-kind', 'glyph');
    // Opened before the server answers, the menu says it's loading and still
    // offers Log out.
    await avatarButton(page).click();
    await expect(menu(page).locator('[part~="menu-pending"]')).toHaveText('Loading account…');
    await expect(menuItems(page)).toHaveText(['Log out']);
    release();
    await expect(menuItems(page)).toHaveText(['Account settings', 'Profile', 'Log out']);
    await expect(menu(page)).toBeVisible();
    await expect(avatarButton(page).locator('.initials')).toHaveText('JD');
  });

  test('the remembered avatar paints first and the server confirms it in place', async ({ page }) => {
    const { release } = await mount(page, {
      holdMe: true,
      me: signedIn({ picture: '/users/me/avatar' }),
      cache: { state: 'signed-in', name: 'Jane Doe', picture: '/users/me/avatar', provider: 'patreon' },
    });
    await expect(avatarButton(page).locator('.initials')).toHaveText('JD');
    await avatarButton(page).evaluate((el) => {
      (window as unknown as { avatarNode: Element }).avatarNode = el.querySelector('[part~="avatar"]')!;
    });
    release();
    await ready(page);
    // Same avatar node: nothing was re-rendered, so nothing flickered.
    expect(
      await avatarButton(page).evaluate(
        (el) => el.querySelector('[part~="avatar"]') === (window as unknown as { avatarNode: Element }).avatarNode,
      ),
    ).toBe(true);
  });

  test('a remembered signed-out visitor never sees an avatar', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { sawAvatar: boolean };
      w.sawAvatar = false;
      new MutationObserver(() => {
        const root = document.querySelector('power-strip')?.shadowRoot;
        if (root?.querySelector('[part~="avatar-button"]')) w.sawAvatar = true;
      }).observe(document, { subtree: true, childList: true });
    });
    const { release } = await mount(page, { holdMe: true, me: null, cache: { state: 'signed-out' } });
    await expect(login(page)).toBeVisible();
    release();
    await ready(page);
    await expect(login(page)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { sawAvatar: boolean }).sawAvatar)).toBe(false);
  });

  test('a server error keeps what was shown, and remembers nothing new', async ({ page }) => {
    await mount(page, { me: 500, cache: { state: 'signed-in', name: 'Jane Doe' } });
    await ready(page);
    await expect(avatarButton(page)).toBeVisible();
    expect(await cache(page)).toEqual({ state: 'signed-in', name: 'Jane Doe' });
  });

  test('with nothing to go on and a server error, it offers to log in', async ({ page }) => {
    await mount(page, { me: 500 });
    await ready(page);
    await expect(login(page)).toBeVisible();
  });

  test('a hidden control asks the server only once it is shown', async ({ page }) => {
    const { requests } = await mount(page, {
      element: '<power-strip variant="compact" providers="patreon" style="display: none"></power-strip>',
    });
    await page.waitForTimeout(300);
    expect(requests).not.toContain('/users/api/me');
    await page.locator('power-strip').evaluate((el) => ((el as HTMLElement).style.display = ''));
    await expect(avatarButton(page)).toBeVisible();
    expect(requests).toContain('/users/api/me');
  });
});

test.describe('page integration', () => {
  test('the page restyles it with --ps-* tokens, even over the dark theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await mount(page, {
      me: null,
      css: 'power-strip { --ps-control-bg: rgb(1, 2, 3); --ps-text: rgb(4, 5, 6); }',
    });
    await expect(login(page)).toHaveCSS('background-color', 'rgb(1, 2, 3)');
    await expect(login(page)).toHaveCSS('color', 'rgb(4, 5, 6)');
  });

  test('announces the sign-in state with power-strip:change', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { changes: unknown[] };
      w.changes = [];
      document.addEventListener('power-strip:change', (e) => w.changes.push((e as CustomEvent).detail));
    });
    await mount(page, { cache: { state: 'signed-in', name: 'Jane Doe' } });
    await ready(page);
    const changes = await page.evaluate(() => (window as unknown as { changes: Record<string, unknown>[] }).changes);
    expect(changes.map((c) => c.source)).toEqual(['cache', 'server']);
    expect(changes[1]).toMatchObject({
      state: 'signed-in',
      user: { name: 'Jane Doe', email: 'jane@example.test', provider: 'patreon' },
      account: { id: 'a1', name: 'Jane Doe', role: 1 },
    });
    expect(await page.locator('power-strip').evaluate((el) => (el as unknown as { state: string }).state)).toBe('signed-in');
  });

  test('menu keys stay in the menu', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { pageKeys: string[] };
      w.pageKeys = [];
      window.addEventListener('keydown', (e) => w.pageKeys.push(e.key));
    });
    await mount(page);
    await avatarButton(page).click();
    await expect(menuItems(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menuItems(page).nth(1)).toBeFocused();
    expect(await page.evaluate(() => (window as unknown as { pageKeys: string[] }).pageKeys)).not.toContain('ArrowDown');
  });
});

test.describe('full variant', () => {
  test('still the corner strip: Login when signed out', async ({ page }) => {
    await mount(page, { me: null, element: '<power-strip providers="patreon"></power-strip>' });
    await expect(page.locator('power-strip #login-trigger')).toHaveText('Login');
  });

  test('still the corner strip: avatar, name and Logout when signed in', async ({ page }) => {
    await mount(page, { element: '<power-strip providers="patreon"></power-strip>' });
    await expect(page.locator('power-strip .user-name')).toHaveText('Jane Doe');
    await expect(page.locator('power-strip .logout-btn')).toHaveText('Logout');
  });
});
