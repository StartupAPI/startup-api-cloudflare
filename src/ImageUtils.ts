import * as photon from '@silvia-odwyer/photon';

let photonInitialized = false;

async function ensurePhoton() {
  if (!photonInitialized) {
    // In Cloudflare Workers, we might need to fetch the wasm file if it's not bundled correctly
    // or use a specific import pattern if configured in wrangler.
    // For now, let's try the default init() which works in many environments.
    // @ts-ignore
    await photon.default();
    photonInitialized = true;
  }
}

/**
 * Resizes an image to a square of specified size, cropping if necessary.
 */
export async function resizeToSquare(imageBuffer: ArrayBuffer, size: number = 500): Promise<ArrayBuffer> {
  console.log('[ImageUtils] Starting resizeToSquare, buffer size:', imageBuffer.byteLength);
  try {
    await ensurePhoton();
    console.log('[ImageUtils] Photon initialized');

    const uint8Array = new Uint8Array(imageBuffer);
    const photonImage = photon.PhotonImage.new_from_bytes(uint8Array);
    
    const width = photonImage.get_width();
    const height = photonImage.get_height();
    console.log('[ImageUtils] Original size:', width, 'x', height);
    
    // Crop to square
    let imageToResize = photonImage;
    const minDim = Math.min(width, height);
    if (width !== height) {
        const x = Math.floor((width - minDim) / 2);
        const y = Math.floor((height - minDim) / 2);
        console.log('[ImageUtils] Cropping to:', minDim, 'x', minDim, 'at', x, ',', y);
        imageToResize = photon.crop(photonImage, x, y, x + minDim, y + minDim);
    }

    // sampling_filter: 1 = Nearest, 2 = Triangle, 3 = CatmullRom, 4 = Gaussian, 5 = Lanczos3
    console.log('[ImageUtils] Resizing to:', size, 'x', size);
    const resizedImage = photon.resize(imageToResize, size, size, 5);
    
    const resultBytes = resizedImage.get_bytes();
    console.log('[ImageUtils] Resize complete, result size:', resultBytes.byteLength);
    
    // Cleanup
    photonImage.free();
    if (imageToResize !== photonImage) {
        imageToResize.free();
    }
    resizedImage.free();

    return resultBytes.buffer as ArrayBuffer;
  } catch (e: any) {
    console.error('[ImageUtils] Error resizing image:', e);
    // If resizing fails, return original buffer as fallback instead of throwing 500
    console.warn('[ImageUtils] Falling back to original image');
    return imageBuffer;
  }
}
