class PowerStrip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.basePath = this.detectBasePath();
    this.user = null;
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
    await this.fetchUser();
    this.render();
    this.addEventListeners();
  }

  async fetchUser() {
    try {
      const res = await fetch(`${this.basePath}/me`);
      if (res.ok) {
        const data = await res.json();
        if (data.valid) {
          this.user = data.profile;
        }
      }
    } catch (e) {
      // Not logged in or error
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
    }
    return '';
  }

  render() {
    const googleLink = `${this.basePath}/auth/google`;
    const twitchLink = `${this.basePath}/auth/twitch`;
    const logoutLink = `${this.basePath}/logout`;

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

    let content = '';

    if (providers.length > 0 && providers[0] !== '') {
      if (this.user) {
        const providerIcon = this.getProviderIcon(this.user.provider);
        content = `
            <div class="user-profile">
              <div class="avatar-container">
                  <img src="${this.user.picture}" alt="${this.user.name}" title="${this.user.name}" class="avatar" width="16" height="16" />
                  <div class="provider-badge ${this.user.provider}">
                      ${providerIcon}
                  </div>
              </div>
              <span class="user-name">${this.user.name}</span>
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
          background-color: rgba(255, 255, 255, 0.7);
          border-radius: 0 0 0 0.3rem;
          box-shadow: 0 0.0625rem 0.1875rem rgba(0,0,0,0.1);
          font-size: 1rem;
        }

        .trigger {
           cursor: pointer;
           padding: 0.125rem 0.375rem;
           transition: background-color 0.2s;
           border-radius: 0.25rem;
           font-size: 0.9rem;
           font-weight: 500;
           color: #444;
           text-decoration: none;
        }

        .trigger:hover {
            background-color: rgba(0, 0, 0, 0.05);
            text-decoration: underline;
            color: #1a73e8;
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

        .user-name {
            font-size: 0.9rem;
            color: #333;
            max-width: 15rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        @media (max-width: 25rem) {
            .user-name {
                display: none;
            }
        }

        /* Dialog Styling */
        dialog {
          border: none;
          border-radius: 0.75rem;
          padding: 0;
          box-shadow: 0 0.625rem 1.5625rem rgba(0,0,0,0.2);
          background: white;
          color: #333;
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
            color: #999;
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
            background-color: #f0f0f0;
            color: #333;
        }

        .auth-buttons {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
        }

        .auth-btn {
            padding: 0.75rem 1rem;
            border: 1px solid #ddd;
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
            background-color: white;
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
            color: #3c4043;
            border-color: #dadce0;
        }
        .auth-btn.google:hover {
            background-color: #f8f9fa;
            border-color: #d2e3fc;
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
    `;
  }

  addEventListeners() {
    const trigger = this.shadowRoot.getElementById('login-trigger');
    const dialog = this.shadowRoot.getElementById('login-dialog');
    const closeBtn = this.shadowRoot.getElementById('close-dialog');

    if (trigger) {
      trigger.addEventListener('click', () => {
        dialog.showModal();
      });
    }

    closeBtn.addEventListener('click', () => {
      dialog.close();
    });

    dialog.addEventListener('click', (e) => {
      const rect = dialog.getBoundingClientRect();
      const isInDialog =
        rect.top <= e.clientY && e.clientY <= rect.top + rect.height && rect.left <= e.clientX && e.clientX <= rect.left + rect.width;
      if (!isInDialog) {
        dialog.close();
      }
    });
  }
}

customElements.define('power-strip', PowerStrip);
