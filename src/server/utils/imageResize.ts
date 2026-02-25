import { createJimp } from '@jimp/core';
import { defaultFormats, defaultPlugins } from 'jimp';
import webp from '@jimp/wasm-webp';

// Custom Jimp instance with WebP support
const Jimp = createJimp({
  formats: [...defaultFormats, webp],
  plugins: defaultPlugins,
});

const MAX_DIMENSION = 1920;

type ImagePayload = { name: string; mimeType: string; data: string };

export async function resizeImageIfNeeded(img: ImagePayload): Promise<ImagePayload> {
  try {
    const buffer = Buffer.from(img.data, 'base64');
    const image = await Jimp.fromBuffer(buffer);
    const { width, height } = image;

    if (width <= MAX_DIMENSION && height <= MAX_DIMENSION) {
      return img; // No resize needed
    }

    // Scale proportionally to fit within MAX_DIMENSION
    image.scaleToFit({ w: MAX_DIMENSION, h: MAX_DIMENSION });

    // GIF loses animation after processing → output as PNG; others keep original format
    const outputMime = img.mimeType === 'image/gif' ? 'image/png' : img.mimeType;
    let outBuffer: Buffer;
    if (outputMime === 'image/jpeg') {
      outBuffer = await image.getBuffer('image/jpeg', { quality: 92 });
    } else {
      outBuffer = await image.getBuffer(outputMime as 'image/png' | 'image/webp' | 'image/bmp' | 'image/tiff');
    }
    const base64 = outBuffer.toString('base64');

    console.log(`[image-resize] Resized ${img.name}: ${width}x${height} → ${image.width}x${image.height}`);

    return { name: img.name, mimeType: outputMime, data: base64 };
  } catch (err) {
    // Unsupported format or processing failure → use original (don't block message)
    console.warn(`[image-resize] Failed to process ${img.name}, using original:`, err);
    return img;
  }
}
