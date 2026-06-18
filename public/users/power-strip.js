class PowerStrip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.basePath = this.detectBasePath();
    this.user = null;
    this.accounts = [];
    // Theme watchers, wired up once on connect and torn down on disconnect.
    this._mediaQuery = null;
    this._onPreferenceChange = null;
    this._pageObserver = null;
  }

  detectBasePath() {
    const script =
      document.currentScript ||
      (function () {
        const scripts = document.getElementsByTagName('script');
        return scripts[scripts.length - 1];
      })();

    if (script && script.src) {
      try {
        const url = new URL(script.src);
        return url.pathname.substring(0, url.pathname.lastIndexOf('/'));
      } catch (e) {
        console.error('Failed to parse script URL', e);
      }
    }
    return '';
  }

  async connectedCallback() {
    // Resolve the theme before the first paint so the strip never flashes the
    // wrong colors, then keep it in sync with the page from here on.
    this.applyTheme();
    this.watchThemeChanges();
    await this.fetchUser();
    this.render();
    this.addEventListeners();
  }

  disconnectedCallback() {
    if (this._mediaQuery && this._onPreferenceChange) {
      this._mediaQuery.removeEventListener('change', this._onPreferenceChange);
    }
    if (this._pageObserver) {
      this._pageObserver.disconnect();
    }
  }

  async refresh() {
    await this.fetchUser();
    this.render();
    this.addEventListeners();
  }

  /**
   * Decide whether the strip should render light or dark by measuring the
   * actual background the strip sits on. This makes the strip match the page
   * regardless of *how* the page chose its theme — a hardcoded dark page, a
   * hardcoded light page, or a page that respects the user's OS preference all
   * resolve to a concrete background color we can read here. When nothing
   * conclusive is found (e.g. a transparent body over an image) we fall back to
   * the user's OS-level color-scheme preference.
   */
  detectPageTheme() {
    const bg = this.getEffectiveBackgroundColor();
    if (bg) {
      return this.isDarkColor(bg) ? 'dark' : 'light';
    }
    return this.prefersDark() ? 'dark' : 'light';
  }

  prefersDark() {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /**
   * Walk up from the strip's placement looking for the first ancestor that
   * paints an opaque (or partly opaque) background, mirroring how the strip is
   * actually composited over the page. Falls back to the document element.
   */
  getEffectiveBackgroundColor() {
    let el = this.parentElement;
    while (el) {
      const color = getComputedStyle(el).backgroundColor;
      if (color && !this.isTransparentColor(color)) {
        return color;
      }
      el = el.parentElement;
    }
    const rootColor = getComputedStyle(document.documentElement).backgroundColor;
    if (rootColor && !this.isTransparentColor(rootColor)) {
      return rootColor;
    }
    return null;
  }

  parseColor(color) {
    const parts = (color.match(/[\d.]+/g) || []).map(Number);
    if (parts.length < 3) {
      return null;
    }
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 ? parts[3] : 1 };
  }

  isTransparentColor(color) {
    if (!color || color === 'transparent') {
      return true;
    }
    const c = this.parseColor(color);
    return !c || c.a === 0;
  }

  isDarkColor(color) {
    const c = this.parseColor(color);
    if (!c) {
      return false;
    }
    // Perceived luminance (ITU-R BT.601). Below the midpoint reads as "dark".
    const luminance = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
    return luminance < 0.5;
  }

  /**
   * Tag the host with the resolved theme. CSS keys all of its colors off this
   * attribute, so updating it is enough to re-theme the whole shadow tree
   * (panel, dialogs and all) without re-rendering or losing dialog state.
   */
  applyTheme() {
    const theme = this.detectPageTheme();
    if (this.getAttribute('data-resolved-theme') !== theme) {
      this.setAttribute('data-resolved-theme', theme);
    }
  }

  watchThemeChanges() {
    // React to the user flipping their OS-level color-scheme preference.
    if (typeof window.matchMedia === 'function') {
      this._mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._onPreferenceChange = () => this.applyTheme();
      this._mediaQuery.addEventListener('change', this._onPreferenceChange);
    }

    // React to the page re-theming itself at runtime — e.g. a theme toggle
    // flipping data-theme/class/style on <html> or <body>.
    if (typeof MutationObserver === 'function') {
      this._pageObserver = new MutationObserver(() => this.applyTheme());
      const observeOptions = { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] };
      this._pageObserver.observe(document.documentElement, observeOptions);
      if (document.body) {
        this._pageObserver.observe(document.body, observeOptions);
      }
    }
  }

  async fetchUser() {
    try {
      const res = await fetch(`${this.basePath}/api/me`);
      if (res.ok) {
        const data = await res.json();
        if (data.valid) {
          this.user = {
            profile: data.profile,
            credential: data.credential,
            is_admin: data.is_admin,
            is_impersonated: data.is_impersonated,
          };
          // Fetch accounts if logged in
          const accountsRes = await fetch(`${this.basePath}/api/me/accounts`);
          if (accountsRes.ok) {
            this.accounts = await accountsRes.json();
          }
        }
      }
    } catch (e) {
      // Not logged in or error
    }
  }

  async switchAccount(accountId) {
    try {
      const res = await fetch(`${this.basePath}/api/me/accounts/switch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ account_id: accountId }),
      });

      if (res.ok) {
        window.location.reload();
      } else {
        console.error('Failed to switch account');
      }
    } catch (e) {
      console.error('Error switching account', e);
    }
  }

  getProviderIcon(provider) {
    if (provider === 'google') {
      return `<svg viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="11" fill="white" stroke="#dadce0" stroke-width="0.5"/>
                <path d="M17.64 12.2c0-.41-.03-.81-.1-1.21H12v2.3h3.16c-.14.73-.57 1.35-1.19 1.79v1.48h1.92c1.12-1.03 1.75-2.55 1.75-4.36z" fill="#4285F4"/>
                <path d="M12 18c1.62 0 2.98-.54 3.97-1.46l-1.92-1.48c-.54.37-1.23.59-2.05.59-1.57 0-2.91-1.06-3.39-2.48H6.65v1.53C7.64 16.69 9.68 18 12 18z" fill="#34A853"/>
                <path d="M8.61 13.17c-.12-.37-.19-.76-.19-1.17s.07-.8.19-1.17V9.3H6.65c-.41.81-.65 1.73-.65 2.7s.24 1.89.65 2.7l1.96-1.53z" fill="#FBBC05"/>
                <path d="M12 8.35c.88 0 1.67.3 2.3.91l1.73-1.73C14.98 6.51 13.62 6 12 6c-2.32 0-4.36 1.31-5.35 3.3L8.61 10.83c.48-1.42 1.82-2.48 3.39-2.48z" fill="#EA4335"/>
              </svg>`;
    } else if (provider === 'twitch') {
      return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#9146FF" stroke="white" stroke-width="1"/><path d="M7 6H6v10h2v3l3-3h3l4-4V6H7zm9 6l-2 2h-3l-2 2v-2H8V7h8v5z" fill="white"/><path d="M14 8.5h1.5v2H14V8.5zm-3 0h1.5v2H11v-2z" fill="white"/></svg>`;
    } else if (provider === 'patreon') {
      return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#FF424D" stroke="white" stroke-width="1"/><circle cx="14" cy="11" r="3.5" fill="white"/><rect x="6.5" y="6.5" width="2" height="11" fill="white"/></svg>`;
    } else if (provider === 'atproto') {
      return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#0085FF" stroke="white" stroke-width="1"/><path d="M12 10.5C10.9 8.4 8.2 6.3 6.3 6c-1.5-.2-1.8.7-1.5 2 .2 1 1.5 5 2.3 6 .9 1.2 2 1.4 3 1.2-1.7.3-3.2 1-1.2 3 .9.9 1.6.3 2.1-.6.5-1 .8-2.1 1-2.6.2.5.5 1.6 1 2.6.5.9 1.2 1.5 2.1.6 2-2 .5-2.7-1.2-3 1 .2 2.1 0 3-1.2.8-1 2.1-5 2.3-6 .3-1.3 0-2.2-1.5-2-1.9.3-4.6 2.4-5.7 4.5z" fill="white"/></svg>`;
    }
    return '';
  }

  render() {
    const returnUrl = encodeURIComponent(window.location.href);
    const googleLink = `${this.basePath}/auth/google?return_url=${returnUrl}`;
    const twitchLink = `${this.basePath}/auth/twitch?return_url=${returnUrl}`;
    const patreonLink = `${this.basePath}/auth/patreon?return_url=${returnUrl}`;
    const atprotoLink = `${this.basePath}/auth/atproto?return_url=${returnUrl}`;
    const logoutLink = `${this.basePath}/logout?return_url=${returnUrl}`;

    const providersStr = this.getAttribute('providers') || '';
    const providers = providersStr.split(',');

    let authButtons = '';
    if (providers.includes('google')) {
      authButtons += `
                <a href="${googleLink}" class="auth-btn google">
                    <svg viewBox="0 0 24 24">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                    </svg>
                    Continue with Google
                </a>`;
    }
    if (providers.includes('twitch')) {
      authButtons += `
                <a href="${twitchLink}" class="auth-btn twitch">
                    <svg viewBox="0 0 24 24">
                      <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" fill="currentColor"/>
                    </svg>
                    Continue with Twitch
                </a>`;
    }
    if (providers.includes('patreon')) {
      authButtons += `
                <a href="${patreonLink}" class="auth-btn patreon">
                    <svg viewBox="0 0 24 24">
                      <path d="M14.82 2.41c3.96 0 7.18 3.24 7.18 7.21 0 3.96-3.22 7.18-7.18 7.18-3.97 0-7.21-3.22-7.21-7.18 0-3.97 3.24-7.21 7.21-7.21M2 21.6h3.5V2.41H2V21.6z" fill="currentColor"/>
                    </svg>
                    Continue with Patreon
                </a>`;
    }
    if (providers.includes('atproto')) {
      authButtons += `
                <a href="${atprotoLink}" class="auth-btn atproto">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 10.5C10.9 8.4 8.2 6.3 6.3 6c-1.5-.2-1.8.7-1.5 2 .2 1 1.5 5 2.3 6 .9 1.2 2 1.4 3 1.2-1.7.3-3.2 1-1.2 3 .9.9 1.6.3 2.1-.6.5-1 .8-2.1 1-2.6.2.5.5 1.6 1 2.6.5.9 1.2 1.5 2.1.6 2-2 .5-2.7-1.2-3 1 .2 2.1 0 3-1.2.8-1 2.1-5 2.3-6 .3-1.3 0-2.2-1.5-2-1.9.3-4.6 2.4-5.7 4.5z" fill="currentColor"/>
                    </svg>
                    Continue with Bluesky
                </a>`;
    }

    let content = '';
    let accountSwitcher = '';

    if (providers.length > 0 && providers[0] !== '') {
      if (this.user) {
        const providerIcon = this.getProviderIcon(this.user.credential.provider);
        const currentAccount = this.accounts.find((a) => a.is_current) || (this.accounts.length > 0 ? this.accounts[0] : null);
        const accountName = currentAccount ? currentAccount.name : 'No Account';

        let switchButton = '';
        let accountContainer = '';

        if (this.accounts.length > 1) {
          switchButton = `
            <button class="trigger switch-btn" id="switch-account-trigger" title="Switch Account">
              <svg viewBox="0 0 24 24" style="width: 0.8rem; height: 0.8rem; fill: currentColor; display: block;">
                <path d="M7 10l5 5 5-5z"/>
              </svg>
            </button>`;

          const accountSettingsLink =
            currentAccount && (currentAccount.role === 1 || this.user.is_admin)
              ? `<a href="${this.basePath}/accounts.html" class="trigger settings-btn" title="Account Settings">
                 <svg viewBox="0 0 24 24" style="width: 0.8rem; height: 0.8rem; fill: currentColor; display: block;">
                   <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.81,11.69,4.81,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.5c-1.93,0-3.5-1.57-3.5-3.5 s1.57-3.5,3.5-3.5s3.5,1.57,3.5,3.5S13.93,15.5,12,15.5z"/>
                 </svg>
               </a>`
              : '';

          accountContainer = `
            <div class="account-container">
                <span class="account-label">${accountName}</span>
                ${switchButton}
                ${accountSettingsLink}
            </div>
          `;

          const accountList = this.accounts
            .map(
              (acc) => `
                <button class="account-item ${acc.is_current ? 'active' : ''}" data-id="${acc.account_id}">
                    <span class="account-name">${acc.name}</span>
                    ${acc.is_current ? '<span class="current-badge">Current</span>' : ''}
                </button>
            `,
            )
            .join('');

          accountSwitcher = `
              <dialog id="account-dialog">
                <div class="dialog-content">
                    <div class="dialog-header">
                        <h2 class="dialog-title">Switch Account</h2>
                        <button class="close-btn" id="close-account-dialog" aria-label="Close">&times;</button>
                    </div>
                    <div class="account-list">
                        ${accountList}
                    </div>
                </div>
              </dialog>
            `;
        }

        const adminLink = this.user.is_admin
          ? `<a href="${this.basePath}/admin/" class="trigger admin-btn" title="Admin Panel" target="startup-api-admin">Admin</a>`
          : '';

        const impersonationLink = this.user.is_impersonated
          ? `<button class="trigger stop-impersonation-btn" id="stop-impersonation-trigger" title="Stop Impersonation">Stop Impersonation</button>`
          : '';

        const avatarContent = this.user.profile.picture
          ? `<img src="${this.user.profile.picture}" alt="${this.user.profile.name}" title="${this.user.profile.name}" class="avatar" width="16" height="16" />`
          : `<div class="avatar placeholder">
              <svg viewBox="0 0 24 24" style="width: 12px; height: 12px;">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
            </div>`;

        content = `
            <div class="user-profile">
              ${adminLink}
              ${impersonationLink}
              ${accountContainer}
              <div class="avatar-container">
                  ${avatarContent}
                  <div class="provider-badge ${this.user.credential.provider}">
                      ${providerIcon}
                  </div>
              </div>
              <div class="user-info">
                  <a href="${this.basePath}/profile.html" class="user-name" title="Edit Profile">${this.user.profile.name}</a>
              </div>
              <a href="${logoutLink}" class="trigger logout-btn" title="Logout">Logout</a>
            </div>
          `;
      } else {
        content = `
            <a class="trigger" id="login-trigger" title="Login" role="button" href="javascript:void(0)">
              Login
            </a>
          `;
      }
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, sans-serif;

          /* Light theme (the default). Every color in the strip is keyed off
             these custom properties so the whole shadow tree can be re-themed
             by flipping a single set of variables. The dark overrides live in
             the rules below — one driven by the user's OS preference (used as a
             flash-free fallback) and one driven by the [data-resolved-theme]
             attribute the component measures and sets at runtime. */
          --ps-panel-bg: rgba(255, 255, 255, 0.85);
          --ps-panel-border: rgba(0, 0, 0, 0.15);
          --ps-panel-shadow: 0 0.0625rem 0.25rem rgba(0, 0, 0, 0.25);
          --ps-text: #333;
          --ps-text-muted: #444;
          --ps-accent: #1a73e8;
          --ps-danger: #d93025;
          --ps-warning: #c77700;
          --ps-hover-bg: rgba(0, 0, 0, 0.06);
          --ps-avatar-bg: #eee;
          --ps-avatar-fg: #999;

          --ps-dialog-bg: #fff;
          --ps-dialog-text: #333;
          --ps-dialog-shadow: 0 0.625rem 1.5625rem rgba(0, 0, 0, 0.25);
          --ps-dialog-muted: #999;
          --ps-dialog-hover-bg: #f0f0f0;
          --ps-surface-bg: #fff;
          --ps-surface-border: #ddd;
          --ps-surface-soft-border: #eee;
          --ps-surface-hover-bg: #f5f5f5;
          --ps-neutral-btn-bg: #fff;
          --ps-neutral-btn-text: #3c4043;
          --ps-neutral-btn-border: #dadce0;
          --ps-neutral-btn-hover-bg: #f8f9fa;
          --ps-active-bg: #e8f0fe;

          color-scheme: light;
        }

        /* Shared dark palette. Applied either when the page has been measured
           as dark, or — before/without measurement — when the user's OS asks
           for dark and the page hasn't been explicitly resolved to light. */
        :host([data-resolved-theme='dark']) {
          --ps-panel-bg: rgba(32, 33, 36, 0.92);
          --ps-panel-border: rgba(255, 255, 255, 0.22);
          --ps-panel-shadow: 0 0.0625rem 0.3125rem rgba(0, 0, 0, 0.65);
          --ps-text: #e8eaed;
          --ps-text-muted: #dadce0;
          --ps-accent: #8ab4f8;
          --ps-danger: #f28b82;
          --ps-warning: #fdd663;
          --ps-hover-bg: rgba(255, 255, 255, 0.12);
          --ps-avatar-bg: #5f6368;
          --ps-avatar-fg: #dadce0;

          --ps-dialog-bg: #2a2b2e;
          --ps-dialog-text: #e8eaed;
          --ps-dialog-shadow: 0 0.625rem 1.5625rem rgba(0, 0, 0, 0.7);
          --ps-dialog-muted: #9aa0a6;
          --ps-dialog-hover-bg: #3c4043;
          --ps-surface-bg: #303134;
          --ps-surface-border: #5f6368;
          --ps-surface-soft-border: #3c4043;
          --ps-surface-hover-bg: #3c4043;
          --ps-neutral-btn-bg: #303134;
          --ps-neutral-btn-text: #e8eaed;
          --ps-neutral-btn-border: #5f6368;
          --ps-neutral-btn-hover-bg: #3c4043;
          --ps-active-bg: #283142;

          color-scheme: dark;
        }

        @media (prefers-color-scheme: dark) {
          :host(:not([data-resolved-theme='light'])) {
            --ps-panel-bg: rgba(32, 33, 36, 0.92);
            --ps-panel-border: rgba(255, 255, 255, 0.22);
            --ps-panel-shadow: 0 0.0625rem 0.3125rem rgba(0, 0, 0, 0.65);
            --ps-text: #e8eaed;
            --ps-text-muted: #dadce0;
            --ps-accent: #8ab4f8;
            --ps-danger: #f28b82;
            --ps-warning: #fdd663;
            --ps-hover-bg: rgba(255, 255, 255, 0.12);
            --ps-avatar-bg: #5f6368;
            --ps-avatar-fg: #dadce0;

            --ps-dialog-bg: #2a2b2e;
            --ps-dialog-text: #e8eaed;
            --ps-dialog-shadow: 0 0.625rem 1.5625rem rgba(0, 0, 0, 0.7);
            --ps-dialog-muted: #9aa0a6;
            --ps-dialog-hover-bg: #3c4043;
            --ps-surface-bg: #303134;
            --ps-surface-border: #5f6368;
            --ps-surface-soft-border: #3c4043;
            --ps-surface-hover-bg: #3c4043;
            --ps-neutral-btn-bg: #303134;
            --ps-neutral-btn-text: #e8eaed;
            --ps-neutral-btn-border: #5f6368;
            --ps-neutral-btn-hover-bg: #3c4043;
            --ps-active-bg: #283142;

            color-scheme: dark;
          }
        }

        /* Honor the native [hidden] attribute so authors can load the script
           without rendering a visible strip (<power-strip hidden>). The :host
           rule above would otherwise override the UA [hidden] { display: none }. */
        :host([hidden]) {
          display: none !important;
        }

        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .container {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          height: 1.3rem;
          padding: 0.0625rem;
          animation: fadeIn 0.4s ease-out;
          background-color: var(--ps-panel-bg);
          /* A contrasting border keeps the chip distinguishable even when its
             panel color happens to be close to the page background. */
          border: 0.0625rem solid var(--ps-panel-border);
          border-top: none;
          border-right: none;
          border-radius: 0 0 0 0.3rem;
          box-shadow: var(--ps-panel-shadow);
          font-size: 1rem;
          backdrop-filter: blur(0.25rem);
        }

        .trigger {
           cursor: pointer;
           padding: 0.125rem 0.375rem;
           transition: background-color 0.2s;
           border-radius: 0.25rem;
           font-size: 0.8rem;
           font-weight: 500;
           color: var(--ps-text-muted);
           text-decoration: none;
           border: none;
           background: transparent;
           line-height: inherit;
        }

        .trigger:hover {
            background-color: var(--ps-hover-bg);
            text-decoration: underline;
            color: var(--ps-accent);
        }

        .switch-btn {
            color: var(--ps-accent);
        }

        svg.bolt, ::slotted(svg) {
          width: 1rem !important;
          height: 1rem !important;
          fill: #ffcc00 !important;
          filter: drop-shadow(0.0625rem 0.0625rem 0.0625rem rgba(0, 0, 0, 0.5));
          flex-shrink: 0;
        }

        .user-profile {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.125rem;
        }

        .avatar-container {
            position: relative;
            width: 1.1rem;
            height: 1.1rem;
        }

        .avatar {
            width: 1.1rem;
            height: 1.1rem;
            border-radius: 50%;
            object-fit: cover;
        }

        .avatar.placeholder {
            background: var(--ps-avatar-bg);
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .avatar.placeholder svg {
            fill: var(--ps-avatar-fg);
        }

        .provider-badge {
            position: absolute;
            bottom: -0.0625rem;
            right: -0.0625rem;
            width: 0.5rem;
            height: 0.5rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .provider-badge svg {
            width: 0.5rem;
            height: 0.5rem;
        }

        .provider-badge.google { color: #3c4043; }
        .provider-badge.twitch { color: #9146FF; }
        .provider-badge.patreon { color: #FF424D; }
        .provider-badge.atproto { color: #0085FF; }

        .user-info {
            display: flex;
            flex-direction: column;
            line-height: 1;
            justify-content: center;
        }

        .account-container {
            display: flex;
            align-items: center;
            gap: 0;
        }

        .user-name {
            font-size: 0.8rem;
            color: var(--ps-text);
            max-width: 10rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: 600;
            text-decoration: none;
            display: block;
        }

        .user-name:hover {
            text-decoration: underline;
            color: var(--ps-accent);
        }

        .account-label {
            font-size: 0.8rem;
            color: var(--ps-accent);
            max-width: 10rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            font-weight: 500;
        }

        .switch-btn {
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 1rem;
            height: 1rem;
        }

        .admin-btn {
            color: var(--ps-danger) !important;
        }

        .stop-impersonation-btn {
            color: var(--ps-warning) !important;
            font-weight: bold;
        }

        @media (max-width: 25rem) {
            .user-info {
                display: none;
            }
        }

        /* Dialog Styling */
        dialog {
          border: none;
          border-radius: 0.75rem;
          padding: 0;
          box-shadow: var(--ps-dialog-shadow);
          background: var(--ps-dialog-bg);
          color: var(--ps-dialog-text);
          max-width: 20rem;
          width: 90%;
          overflow: hidden;
        }

        dialog::backdrop {
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(0.125rem);
        }

        .dialog-content {
            padding: 1.5rem;
        }

        .dialog-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.25rem;
        }

        .dialog-title {
            font-weight: 700;
            font-size: 1.25rem;
            margin: 0;
        }

        .close-btn {
            background: none;
            border: none;
            cursor: pointer;
            font-size: 1.5rem;
            color: var(--ps-dialog-muted);
            padding: 0;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 1.5rem;
            height: 1.5rem;
            border-radius: 50%;
            transition: background-color 0.2s, color 0.2s;
        }

        .close-btn:hover {
            background-color: var(--ps-dialog-hover-bg);
            color: var(--ps-dialog-text);
        }

        .auth-buttons {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .auth-btn {
            padding: 0.75rem 1rem;
            border: 1px solid var(--ps-surface-border);
            border-radius: 0.375rem;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.75rem;
            font-weight: 500;
            font-size: 1rem;
            transition: all 0.2s ease;
            text-decoration: none;
            color: inherit;
            background-color: var(--ps-neutral-btn-bg);
        }

        .auth-btn:hover {
            transform: translateY(-0.0625rem);
            box-shadow: 0 0.125rem 0.3125rem rgba(0,0,0,0.05);
        }

        .auth-btn:active {
            transform: translateY(0);
        }

        .auth-btn svg {
            width: 1.5rem;
            height: 1.5rem;
        }

        .auth-btn.google {
            color: var(--ps-neutral-btn-text);
            background-color: var(--ps-neutral-btn-bg);
            border-color: var(--ps-neutral-btn-border);
        }
        .auth-btn.google:hover {
            background-color: var(--ps-neutral-btn-hover-bg);
        }

        .auth-btn.twitch {
            background-color: #9146FF;
            color: white;
            border-color: #9146FF;
        }
        .auth-btn.twitch:hover {
            background-color: #7d2ee6;
            border-color: #7d2ee6;
        }

        .auth-btn.patreon {
            background-color: #FF424D;
            color: white;
            border-color: #FF424D;
        }
        .auth-btn.patreon:hover {
            background-color: #e63a44;
            border-color: #e63a44;
        }

        .auth-btn.atproto {
            background-color: #0085FF;
            color: white;
            border-color: #0085FF;
        }
        .auth-btn.atproto:hover {
            background-color: #006fd6;
            border-color: #006fd6;
        }

        /* Account Switcher Styling */
        .account-list {
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
        }

        .account-item {
            padding: 0.75rem;
            border: 1px solid var(--ps-surface-soft-border);
            border-radius: 0.375rem;
            background: var(--ps-surface-bg);
            color: var(--ps-dialog-text);
            text-align: left;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s;
            font-size: 1rem;
            gap: 1rem;
        }

        .account-item:hover {
            background-color: var(--ps-surface-hover-bg);
        }

        .account-item.active {
            border-color: var(--ps-accent);
            background-color: var(--ps-active-bg);
        }

        .current-badge {
            font-size: 0.75rem;
            background: var(--ps-accent);
            color: white;
            padding: 0.125rem 0.375rem;
            border-radius: 0.75rem;
        }
      </style>

      <div class="container">
        ${content}
        <slot></slot>
      </div>

      <dialog id="login-dialog">
        <div class="dialog-content">
            <div class="dialog-header">
                <h2 class="dialog-title">Log in</h2>
                <button class="close-btn" id="close-dialog" aria-label="Close">&times;</button>
            </div>
            <div class="auth-buttons">
                ${authButtons}
            </div>
        </div>
      </dialog>

      ${accountSwitcher}
    `;
  }

  async stopImpersonation() {
    try {
      const res = await fetch(`${this.basePath}/api/stop-impersonation`, {
        method: 'POST',
      });
      if (res.ok) {
        window.location.reload();
      } else {
        console.error('Failed to stop impersonation');
      }
    } catch (e) {
      console.error('Error stopping impersonation', e);
    }
  }

  addEventListeners() {
    const loginTrigger = this.shadowRoot.getElementById('login-trigger');
    const loginDialog = this.shadowRoot.getElementById('login-dialog');
    const closeLoginBtn = this.shadowRoot.getElementById('close-dialog');

    if (loginTrigger) {
      loginTrigger.addEventListener('click', () => {
        loginDialog.showModal();
      });
    }

    if (closeLoginBtn) {
      closeLoginBtn.addEventListener('click', () => {
        loginDialog.close();
      });
    }

    if (loginDialog) {
      loginDialog.addEventListener('click', (e) => {
        const rect = loginDialog.getBoundingClientRect();
        const isInDialog =
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
        if (!isInDialog) {
          loginDialog.close();
        }
      });
    }

    // Impersonation logic
    const stopImpersonationTrigger = this.shadowRoot.getElementById('stop-impersonation-trigger');
    if (stopImpersonationTrigger) {
      stopImpersonationTrigger.addEventListener('click', () => {
        this.stopImpersonation();
      });
    }

    // Account Switcher Logic
    const switchTrigger = this.shadowRoot.getElementById('switch-account-trigger');
    const accountDialog = this.shadowRoot.getElementById('account-dialog');
    const closeAccountBtn = this.shadowRoot.getElementById('close-account-dialog');

    if (switchTrigger && accountDialog) {
      switchTrigger.addEventListener('click', () => {
        accountDialog.showModal();
      });

      if (closeAccountBtn) {
        closeAccountBtn.addEventListener('click', () => {
          accountDialog.close();
        });
      }

      accountDialog.addEventListener('click', (e) => {
        const rect = accountDialog.getBoundingClientRect();
        const isInDialog =
          rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
        if (!isInDialog) {
          accountDialog.close();
        }
      });

      const accountItems = this.shadowRoot.querySelectorAll('.account-item');
      accountItems.forEach((item) => {
        item.addEventListener('click', () => {
          const accountId = item.getAttribute('data-id');
          this.switchAccount(accountId);
        });
      });
    }
  }
}

customElements.define('power-strip', PowerStrip);
