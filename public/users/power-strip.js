class PowerStrip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.basePath = this.detectBasePath();
  }

  detectBasePath() {
    const script = document.currentScript || (function() {
      const scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();
    
    if (script && script.src) {
      try {
        const url = new URL(script.src);
        // Get the directory of the script
        const path = url.pathname.substring(0, url.pathname.lastIndexOf('/'));
        // If the path ends with /users, we want to go up one level if the intended API root is distinct,
        // but based on the request "read the path which was used to load power-strip.js file",
        // we should likely use that directory as the base or the root it implies.
        // Assuming the script is served from `USERS_PATH` (e.g. /users/), and auth routes are relative to that or root.
        // The user asked to use the path as a prefix.
        // If script is at /users/power-strip.js, base is /users
        return path;
      } catch (e) {
        console.error("Failed to parse script URL", e);
      }
    }
    return '';
  }

  connectedCallback() {
    this.render();
    this.addEventListeners();
  }

  render() {
    const googleLink = `${this.basePath}/auth/google`;
    const twitchLink = `${this.basePath}/auth/twitch`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, -apple-system, sans-serif;
        }
        
        /* Main Container Styling */
        .container {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0.3rem;
        }

        /* Trigger (Login link) Styling */
        .trigger {
           cursor: pointer;
           padding: 2px 6px;
           transition: background-color 0.2s;
           border-radius: 4px;
           font-size: 0.9rem;
           font-weight: 500;
           color: #444;
           text-decoration: none;
        }

        .trigger:hover {
            background-color: rgba(0, 0, 0, 0.05);
            text-decoration: underline;
            color: #1a73e8; /* Standard-ish blue for links on hover */
        }

        svg.bolt {
          width: 1rem;
          height: 1rem;
          fill: #ffcc00; 
          filter: drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.5));
          flex-shrink: 0;
        }

        /* Dialog Styling */
        dialog {
          border: none;
          border-radius: 12px;
          padding: 0;
          box-shadow: 0 10px 25px rgba(0,0,0,0.2);
          background: white;
          color: #333;
          max-width: 320px;
          width: 90%;
          overflow: hidden;
        }

        dialog::backdrop {
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(2px);
        }

        .dialog-content {
            padding: 24px;
        }

        .dialog-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
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
            width: 24px;
            height: 24px;
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
            gap: 12px;
        }

        .auth-btn {
            padding: 12px 16px;
            border: 1px solid #ddd;
            border-radius: 6px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 12px;
            font-weight: 500;
            font-size: 1rem;
            transition: all 0.2s ease;
            text-decoration: none;
            color: inherit;
            background-color: white;
        }

        .auth-btn:hover {
            transform: translateY(-1px);
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
        }

        .auth-btn:active {
            transform: translateY(0);
        }

        .auth-btn svg {
            width: 20px;
            height: 20px;
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
        <svg class="bolt" viewBox="0 0 24 24">
          <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
        </svg>
        <a class="trigger" id="login-trigger" title="Login" role="button" href="javascript:void(0)">
          Login
        </a>
      </div>

      <dialog id="login-dialog">
        <div class="dialog-content">
            <div class="dialog-header">
                <h2 class="dialog-title">Log in</h2>
                <button class="close-btn" id="close-dialog" aria-label="Close">&times;</button>
            </div>
            <div class="auth-buttons">
                <a href="${googleLink}" class="auth-btn google">
                    <svg viewBox="0 0 24 24" style="fill:currentColor;"><path d="M12.24 10.285V14.4h6.806c-.275 1.765-2.056 5.174-6.806 5.174-4.095 0-7.439-3.389-7.439-7.574s3.345-7.574 7.439-7.574c2.33 0 3.891.989 4.785 1.849l3.254-3.138C18.189 1.186 15.479 0 12.24 0c-6.635 0-12 5.365-12 12s5.365 12 12 12c6.926 0 11.52-4.869 11.52-11.726 0-.788-.085-1.39-.189-1.989H12.24z"/></svg>
                    Continue with Google
                </a>
                <a href="${twitchLink}" class="auth-btn twitch">
                    <svg viewBox="0 0 24 24" style="fill:currentColor;"><path d="M2.149 0L.537 4.119v16.836h5.731V24h3.224l3.045-3.045h4.657l6.269-6.269V0H2.149zm19.164 13.612l-3.582 3.582H12l-3.045 3.045v-3.045H4.119V2.149h17.194v11.463z"/></svg>
                    Continue with Twitch
                </a>
            </div>
        </div>
      </dialog>
    `;
  }

  addEventListeners() {
    const trigger = this.shadowRoot.getElementById('login-trigger');
    const dialog = this.shadowRoot.getElementById('login-dialog');
    const closeBtn = this.shadowRoot.getElementById('close-dialog');

    trigger.addEventListener('click', () => {
      dialog.showModal();
    });

    closeBtn.addEventListener('click', () => {
      dialog.close();
    });

    // Close on click outside
    dialog.addEventListener('click', (e) => {
      const rect = dialog.getBoundingClientRect();
      const isInDialog = (rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX && e.clientX <= rect.left + rect.width);
      if (!isInDialog) {
        dialog.close();
      }
    });
  }
}

customElements.define('power-strip', PowerStrip);