import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('Image Storage in R2', () => {
  it('should store and retrieve user avatar in R2', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const imageData = new Uint8Array([1, 2, 3, 4]).buffer;
    const mimeType = 'image/png';

    // Store image
    await stub.storeImage('avatar', imageData, mimeType);

    // Retrieve image
    const image = await stub.getImage('avatar');
    expect(image).not.toBeNull();
    expect(new Uint8Array(image.value)).toEqual(new Uint8Array(imageData));
    expect(image.mime_type).toBe(mimeType);
  });

  it('should store and retrieve account avatar in R2', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);

    const imageData = new Uint8Array([5, 6, 7, 8]).buffer;
    const mimeType = 'image/jpeg';

    // Store image
    await stub.storeImage('avatar', imageData, mimeType);

    // Retrieve image
    const image = await stub.getImage('avatar');
    expect(image).not.toBeNull();
    expect(new Uint8Array(image.value)).toEqual(new Uint8Array(imageData));
    expect(image.mime_type).toBe(mimeType);
  });

  it('should return null for non-existent image', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);

    const image = await stub.getImage('non-existent');
    expect(image).toBeNull();
  });

  it('should cleanup R2 on user deletion', async () => {
    const id = env.USER.newUniqueId();
    const stub = env.USER.get(id);
    const idStr = id.toString();

    const imageData = new Uint8Array([1, 2, 3, 4]).buffer;
    await stub.storeImage('avatar', imageData, 'image/png');

    // Verify it exists in R2
    const r2Key = `user/${idStr}/avatar`;
    const object = await env.IMAGES.get(r2Key);
    expect(object).not.toBeNull();

    // Delete user
    await stub.delete();

    // Verify it is gone from R2
    const deletedObject = await env.IMAGES.get(r2Key);
    expect(deletedObject).toBeNull();
  });

  it('should cleanup R2 on account deletion', async () => {
    const id = env.ACCOUNT.newUniqueId();
    const stub = env.ACCOUNT.get(id);
    const idStr = id.toString();

    const imageData = new Uint8Array([5, 6, 7, 8]).buffer;
    await stub.storeImage('avatar', imageData, 'image/jpeg');

    // Verify it exists in R2
    const r2Key = `account/${idStr}/avatar`;
    const object = await env.IMAGES.get(r2Key);
    expect(object).not.toBeNull();

    // Delete account
    await stub.delete();

    // Verify it is gone from R2
    const deletedObject = await env.IMAGES.get(r2Key);
    expect(deletedObject).toBeNull();
  });
});
