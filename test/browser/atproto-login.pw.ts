import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page, type Route } from '@playwright/test';
import { AtprotoProvider } from '../../src/auth/AtprotoProvider';
import type { AuthContext } from '../../src/auth/OAuthProvider';
import type { StartupAPIEnv } from '../../src/StartupAPIEnv';
import type { ProviderOptions } from '../../src/schemas/config';

// The atproto login form's script (public/users/atproto-login.js): the Continue button's states and
// handle autocomplete. The page is the form AtprotoProvider really renders, served with its real
// headers, so the CSP is enforced too.

const ORIGIN = 'https://app.test';
const SCRIPT = readFileSync(resolve(__dirname, '../../public/users/atproto-login.js'), 'utf8');
const STYLES = readFileSync(resolve(__dirname, '../../public/users/style.css'), 'utf8');
const AVATAR = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const ACTORS = [
  { did: 'did:plc:alice', handle: 'alice.test', displayName: 'Alice <b>Bold</b>', avatar: 'https://cdn.test/alice.png' },
  { did: 'did:plc:alicia', handle: 'alicia.test' },
];

interface MountOptions {
  /** What the typeahead proxy answers. */
  actors?: unknown[];
  /** Provider options, e.g. `{ typeahead: false }`. */
  provider?: ProviderOptions;
  /** Render the form as re-shown after a failed login, pre-filled with this handle. */
  prefill?: string;
  /**
   * Record login submissions but cancel their navigation, freezing the page as the user sees it while
   * the redirect to their own server is under way.
   */
  holdSubmit?: boolean;
}

function renderForm({ provider: options = {}, prefill }: MountOptions): Response {
  const provider = AtprotoProvider.create({} as StartupAPIEnv, `${ORIGIN}/users/auth`, options)!;
  const ctx = { url: new URL(`${ORIGIN}/users/auth/atproto`), authPath: '/users/auth', usersPath: '/users/' } as AuthContext;
  const form = provider as unknown as {
    renderHandleForm(ctx: AuthContext, returnUrl: string | null, options: { error?: string; handle?: string }): Response;
  };
  return form.renderHandleForm(ctx, null, prefill ? { error: 'Could not resolve handle', handle: prefill } : {});
}

/** Open the form. Returns the typeahead queries and login submissions it received. */
async function mount(page: Page, options: MountOptions = {}) {
  const { actors = ACTORS, holdSubmit = false } = options;
  const form = renderForm(options);
  const formHtml = await form.text();
  const formHeaders = Object.fromEntries(form.headers);
  const queries: string[] = [];
  const submitted: string[] = [];

  await page.route('https://**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'https://cdn.test') return route.fulfill({ contentType: 'image/png', body: AVATAR });
    switch (url.pathname) {
      case '/users/auth/atproto':
        if (url.searchParams.has('handle')) {
          submitted.push(url.searchParams.get('handle')!);
          return route.fulfill({ body: 'submitted' });
        }
        return route.fulfill({ status: form.status, headers: formHeaders, body: formHtml });
      case '/users/atproto-login.js':
        return route.fulfill({ contentType: 'text/javascript', body: SCRIPT });
      case '/users/style.css':
        return route.fulfill({ contentType: 'text/css', body: STYLES });
      case '/users/auth/atproto/typeahead':
        queries.push(url.searchParams.get('q')!);
        return route.fulfill({ json: { actors } });
      default:
        return route.fulfill({ status: 404, body: 'Not found' });
    }
  });
  if (holdSubmit) await page.exposeFunction('recordSubmit', (handle: string) => submitted.push(handle));
  await page.goto(`${ORIGIN}/users/auth/atproto`);
  if (holdSubmit) {
    // Added after the login script's own listener, so that one has already run.
    await page.evaluate(() =>
      document.querySelector('form')!.addEventListener('submit', (event) => {
        event.preventDefault();
        const w = window as unknown as { recordSubmit(handle: string): void };
        w.recordSubmit(new FormData(event.target as HTMLFormElement).get('handle') as string);
      }),
    );
  }
  return { queries, submitted };
}

const input = (page: Page) => page.getByRole('textbox', { name: 'Your handle or DID' });
const group = (page: Page) => page.getByRole('group', { name: 'Or pick your account' });
const choices = (page: Page) => group(page).getByRole('button');
const status = (page: Page) => page.getByRole('status');
const button = (page: Page) => page.getByRole('button', { name: /Continue|Logging in/ });
const selected = (page: Page) => page.locator('.handle-field .selected');

test.describe('suggestions', () => {
  test('lists matching accounts as buttons under a heading, and announces them', async ({ page }) => {
    const { queries } = await mount(page);
    await input(page).pressSequentially('ali');

    await expect(choices(page)).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'Or pick your account' })).toBeVisible();
    await expect(group(page).getByRole('list')).toBeVisible();
    // Names are shown as text, never as markup; the avatar is decorative.
    await expect(choices(page).first()).toHaveAccessibleName('Alice <b>Bold</b> @alice.test');
    await expect(choices(page).first().locator('img')).toHaveAttribute('alt', '');
    await expect(choices(page).first().locator('img')).toHaveJSProperty('complete', true);
    await expect(status(page)).toHaveText('2 accounts found below the Continue button. Press Down Arrow to choose.');
    // Debounced: typing quickly sends one query, not one per keystroke.
    expect(queries).toEqual(['ali']);
  });

  test('stay listed when focus leaves the field', async ({ page }) => {
    await mount(page);
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);
    await page.locator('h1').click();
    await expect(choices(page)).toHaveCount(2);
  });

  test('Tab reaches them after Continue, and Enter logs in with one', async ({ page, browserName }) => {
    // Safari tabs only between text fields unless "Press Tab to highlight each item" is on; the arrow
    // keys (tested below) are how Safari users reach the accounts by default.
    test.skip(browserName === 'webkit', 'Safari does not Tab to buttons by default');
    const { submitted } = await mount(page);
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);

    await page.keyboard.press('Tab');
    await expect(button(page)).toBeFocused(); // dimmed but still reachable
    await page.keyboard.press('Tab');
    await expect(choices(page).first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(choices(page).nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => submitted).toEqual(['alicia.test']);
  });

  test('Space logs in with the focused one', async ({ page }) => {
    const { submitted } = await mount(page);
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);
    await input(page).press('ArrowDown');
    await page.keyboard.press('Space');
    await expect.poll(() => submitted).toEqual(['alice.test']);
  });

  test('arrow keys move between the field and the accounts', async ({ page }) => {
    await mount(page);
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);

    await input(page).press('ArrowDown');
    await expect(choices(page).first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(choices(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown'); // stays on the last one
    await expect(choices(page).nth(1)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(choices(page).first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(choices(page).nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp'); // up from the first one: back to the field
    await expect(input(page)).toBeFocused();
  });

  test('Escape on an account goes back to the field and closes the list', async ({ page }) => {
    await mount(page);
    await input(page).pressSequentially('ali');
    await input(page).press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(input(page)).toBeFocused();
    await expect(group(page)).toBeHidden();
    await expect(status(page)).toHaveText('');
  });

  test('Escape in the field closes the list and Enter then submits what was typed', async ({ page }) => {
    const { submitted } = await mount(page);
    await input(page).pressSequentially('alice.example');
    await expect(choices(page)).toHaveCount(2);
    await input(page).press('Escape');
    await expect(group(page)).toBeHidden();
    await input(page).press('Enter');
    await expect.poll(() => submitted).toEqual(['alice.example']);
  });

  test('clicking one logs in with it', async ({ page }) => {
    const { submitted } = await mount(page);
    await input(page).pressSequentially('ali');
    await choices(page).nth(1).click();
    await expect.poll(() => submitted).toEqual(['alicia.test']);
  });

  test('hover highlights the account you would log in with', async ({ page }) => {
    await mount(page);
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);
    const background = (i: number) =>
      choices(page)
        .nth(i)
        .evaluate((el) => getComputedStyle(el).backgroundColor);
    const plain = await background(1);
    await choices(page).nth(1).hover();
    await expect.poll(() => background(1)).not.toBe(plain);
    expect(await background(0)).toBe(plain);
  });

  test('sit below Continue, which never moves or gets covered', async ({ page }) => {
    await mount(page);
    const before = await button(page).boundingBox();
    await input(page).pressSequentially('ali');
    await expect(group(page)).toBeVisible();

    expect(await button(page).boundingBox()).toEqual(before);
    const groupBox = (await group(page).boundingBox())!;
    expect(groupBox.y).toBeGreaterThanOrEqual(before!.y + before!.height);
    const center = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.textContent, center)).toBe('Continue');
  });

  test("leave the browser's own suggestions on until ours are listed", async ({ page }) => {
    await mount(page);
    // Nothing typed yet: the browser may offer a handle saved from a past login.
    await expect(input(page)).toHaveAttribute('autocomplete', 'username');
    await expect(input(page)).not.toHaveAttribute('data-1p-ignore');

    // Ours are listed: the browser's and password managers' popups would cover them.
    await input(page).pressSequentially('ali');
    await expect(choices(page)).toHaveCount(2);
    await expect(input(page)).toHaveAttribute('autocomplete', 'off');
    await expect(input(page)).toHaveAttribute('data-1p-ignore', '');

    // Closed again: theirs are back.
    await input(page).press('Escape');
    await expect(input(page)).toHaveAttribute('autocomplete', 'username');
    await expect(input(page)).not.toHaveAttribute('data-1p-ignore');
  });

  test("keep the browser's suggestions when ours find nothing", async ({ page }) => {
    const { queries } = await mount(page, { actors: [] });
    await input(page).pressSequentially('zzz');
    await expect.poll(() => queries).toEqual(['zzz']);
    await expect(input(page)).toHaveAttribute('autocomplete', 'username');
    await expect(group(page)).toBeHidden();
    await expect(status(page)).toHaveText('');
  });

  test('are not searched for one character or a DID', async ({ page }) => {
    const { queries } = await mount(page);
    await input(page).pressSequentially('a');
    await input(page).fill('did:plc:alice');
    await page.waitForTimeout(400);
    expect(queries).toEqual([]);
    await expect(group(page)).toBeHidden();
  });
});

test.describe('the field', () => {
  test('is described by the hint, and suits an identifier', async ({ page }) => {
    await mount(page);
    await expect(input(page)).toHaveAccessibleDescription("For example alice.bsky.social. Your account's own server handles the login.");
    await expect(input(page)).toHaveAttribute('autocapitalize', 'off');
    await expect(input(page)).toHaveAttribute('spellcheck', 'false');
    expect(await input(page).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px'); // no iOS zoom
  });

  test('after a failed login, is marked invalid and described by the error too', async ({ page }) => {
    await mount(page, { prefill: 'ghost.invalid' });
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(input(page)).toHaveAccessibleDescription(/handles the login\. Could not resolve handle/);
  });
});

test.describe('Continue button', () => {
  test('is disabled until the field holds a valid handle or DID', async ({ page }) => {
    await mount(page, { actors: [] });
    await expect(button(page)).toBeDisabled();
    for (const value of ['alice', 'alice.', '-alice.test', 'did:plc:']) {
      await input(page).fill(value);
      await expect(button(page), value).toBeDisabled();
    }
    for (const value of ['alice.test', '@alice.bsky.social', 'did:plc:ewvi7nxzyoun6zhxrhs64oiz', 'did:web:example.com']) {
      await input(page).fill(value);
      await expect(button(page), value).toBeEnabled();
    }
  });

  test('stays focusable while dimmed, and pressing it early explains why instead of logging in', async ({ page }) => {
    const { submitted } = await mount(page, { actors: [] });
    await input(page).fill('alice');
    await expect(button(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(button(page)).not.toHaveAttribute('disabled');

    // Pressed from the keyboard (a pointer click works the same; Playwright won't click aria-disabled).
    await button(page).focus();
    await page.keyboard.press('Enter');
    await expect(input(page)).toBeFocused(); // the browser points at the field
    await input(page).press('Enter');
    await page.waitForTimeout(300);
    expect(submitted).toEqual([]);
    expect(await input(page).evaluate((el: HTMLInputElement) => el.validationMessage)).toBe(
      'Enter your full handle, like alice.bsky.social, or a DID.',
    );
  });

  test('is enabled for a valid handle pre-filled after a failed login', async ({ page }) => {
    await mount(page, { prefill: 'alice.test' });
    await expect(input(page)).toHaveValue('alice.test');
    await expect(button(page)).toBeEnabled();
  });

  test('says "Logging in…" and stays disabled once a typed handle is submitted', async ({ page }) => {
    const { submitted } = await mount(page, { actors: [], holdSubmit: true });
    await input(page).fill('alice.test');
    await button(page).click();
    await expect.poll(() => submitted).toEqual(['alice.test']);
    await expect(button(page)).toHaveText('Logging in…');
    await expect(button(page)).toHaveAttribute('disabled'); // truly disabled now: no double login
    await expect(page.locator('form')).toHaveAttribute('aria-busy', 'true');
  });

  test('works the same with typeahead off', async ({ page }) => {
    const { submitted } = await mount(page, { provider: { typeahead: false }, holdSubmit: true });
    await expect(input(page)).toBeVisible();
    await expect(button(page)).toBeDisabled();
    await input(page).fill('alice.test');
    await button(page).click();
    await expect.poll(() => submitted).toEqual(['alice.test']);
    await expect(button(page)).toHaveText('Logging in…');
  });
});

test.describe('picking a suggestion', () => {
  test('shows just that account in place of the field while logging in', async ({ page }) => {
    const { submitted } = await mount(page, { holdSubmit: true });
    await input(page).pressSequentially('ali');
    await choices(page).first().click();

    await expect.poll(() => submitted).toEqual(['alice.test']);
    await expect(input(page)).toBeHidden();
    await expect(group(page)).toBeHidden();
    await expect(selected(page)).toBeVisible();
    // Focus moves to it (not lost with the button that was clicked), and it says what is happening.
    await expect(selected(page)).toBeFocused();
    await expect(selected(page)).toContainText('Logging in as');
    await expect(selected(page)).toContainText('Alice <b>Bold</b>');
    await expect(selected(page)).toContainText('@alice.test');
    await expect(selected(page).locator('img')).toHaveAttribute('src', 'https://cdn.test/alice.png');
    await expect(button(page)).toHaveText('Logging in…');
    await expect(button(page)).toBeDisabled();
  });

  test('back from the login page: the field holds the picked handle and Continue is enabled', async ({ page }) => {
    // The form is no-store, so Back reloads it and the browser refills the field after the script ran.
    await mount(page);
    await input(page).pressSequentially('ali');
    await choices(page).first().click();
    await expect(page.getByText('submitted')).toBeVisible();

    await page.goBack();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue('alice.test');
    await expect(button(page)).toHaveText('Continue');
    await expect(button(page)).toBeEnabled();
  });

  test('back from the redirect (back/forward cache) shows the field again', async ({ page }) => {
    const { submitted } = await mount(page, { holdSubmit: true });
    await input(page).pressSequentially('ali');
    await choices(page).first().click();
    await expect.poll(() => submitted).toEqual(['alice.test']);

    // What a browser fires when it restores the page from its back/forward cache.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(selected(page)).toBeHidden();
    await expect(input(page)).toBeVisible();
    await expect(input(page)).toHaveValue('alice.test');
    await expect(button(page)).toHaveText('Continue');
    await expect(button(page)).toBeEnabled();
  });
});
