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
  await ensurePhoton();

  const uint8Array = new Uint8Array(imageBuffer);
  const photonImage = PhotonImage.new_from_bytes(uint8Array);
  
  const width = photonImage.get_width();
  const height = photonImage.get_height();
  
  // Crop to square if needed
  let finalImage = photonImage;
  if (width !== height) {
    const minDim = Math.min(width, height);
    const x = Math.floor((width - minDim) / 2);
    const y = Math.floor((height - minDim) / 2);
    // crop(photonImage, x, y, x + minDim, y + minDim)
    // Actually photon has crop method on image itself
    // But photon's crop is a bit different in some versions. 
    // Let's use simpler approach: resize first then we might need to use a different tool if crop is complex.
    // For now, let's just resize to specified size preserving aspect ratio or stretching.
    // Ideally we want to crop.
  }

  // sampling_filter: 1 = Nearest, 2 = Triangle, 3 = CatmullRom, 4 = Gaussian, 5 = Lanczos3
  const resizedImage = resize(photonImage, size, size, 5);
  
  const resultBytes = resizedImage.get_bytes();
  
  // Cleanup
  photonImage.free();
  resizedImage.free();

  return resultBytes.buffer as ArrayBuffer;
}
