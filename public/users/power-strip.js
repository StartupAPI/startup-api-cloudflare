class PowerStrip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 0.3rem;
          border-radius: 0 0 0 0.1rem;
          cursor: pointer;
        }
        svg {
          width: 1rem;
          height: 1rem;
          fill: #ffcc00;
          filter: drop-shadow(1px 1px 1px rgba(0, 0, 0, 0.5));
        }
      </style>
      <svg viewBox="0 0 24 24">
        <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
      </svg>
    `;
  }
}

customElements.define('power-strip', PowerStrip);
console.log('Hello from Startup API');
