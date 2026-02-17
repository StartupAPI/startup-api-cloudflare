import init, { PhotonImage, resize, sampling_filter } from '@silvia-odwyer/photon';

let photonInitialized = false;

async function ensurePhoton() {
  if (!photonInitialized) {
    await init();
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
    const photonImage = PhotonImage.new_from_bytes(uint8Array);
    
    const width = photonImage.get_width();
    const height = photonImage.get_height();
    console.log('[ImageUtils] Original size:', width, 'x', height);
    
    // sampling_filter: 1 = Nearest, 2 = Triangle, 3 = CatmullRom, 4 = Gaussian, 5 = Lanczos3
    console.log('[ImageUtils] Resizing to:', size, 'x', size);
    const resizedImage = resize(photonImage, size, size, 5);
    
    const resultBytes = resizedImage.get_bytes();
    console.log('[ImageUtils] Resize complete, result size:', resultBytes.byteLength);
    
    // Cleanup
    photonImage.free();
    resizedImage.free();

    return resultBytes.buffer as ArrayBuffer;
  } catch (e: any) {
    console.error('[ImageUtils] Error resizing image:', e);
    throw e;
  }
}
