export class CookieManager {
  private keyPromise: Promise<CryptoKey> | null = null;

  constructor(private secret: string) {}

  private async getKey(): Promise<CryptoKey> {
    if (this.keyPromise) return this.keyPromise;

    this.keyPromise = (async () => {
      const encoder = new TextEncoder();
      const secretData = encoder.encode(this.secret);
      const hash = await crypto.subtle.digest('SHA-256', secretData);
      return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();

    return this.keyPromise;
  }

  async encrypt(value: string): Promise<string> {
    const key = await this.getKey();
    const encoder = new TextEncoder();
    const data = encoder.encode(value);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  async decrypt(encrypted: string): Promise<string | null> {
    try {
      const key = await this.getKey();
      const base64 = encrypted.replace(/-/g, '+').replace(/_/g, '/');
      const combined = new Uint8Array(
        atob(base64)
          .split('')
          .map((c) => c.charCodeAt(0)),
      );

      const iv = combined.slice(0, 12);
      const ciphertext = combined.slice(12);

      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
      return new TextDecoder().decode(decrypted);
    } catch (e) {
      console.error('Failed to decrypt cookie:', e);
      return null;
    }
  }
}
