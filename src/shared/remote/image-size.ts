/**
 * An image's size in pixels as its header says, read without decoding it:
 * a small file can say it is huge (a decompression bomb), and drawing it,
 * or drawing it smaller, would decode all of it first. PNG, JPEG, GIF and
 * WebP, the images another device is sent; null for one whose header does
 * not tell. Plain bytes, no Buffer: the renderer reads chat images with it.
 */

/** The most pixels an image is decoded with to be drawn smaller: 8K by 6K. */
export const MAX_DECODED_PIXELS = 8192 * 6144;

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export function pixelSizeOf(bytes: Uint8Array): PixelSize | null {
  const b = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.byteLength >= 24 && b.getUint32(0) === 0x89504e47 && ascii(b, 12, 16) === "IHDR") {
    return { width: b.getUint32(16), height: b.getUint32(20) };
  }
  if (b.byteLength >= 10 && ascii(b, 0, 3) === "GIF") {
    return { width: b.getUint16(6, true), height: b.getUint16(8, true) };
  }
  if (b.byteLength >= 4 && b.getUint8(0) === 0xff && b.getUint8(1) === 0xd8) return jpegSize(b);
  if (b.byteLength >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") {
    return webpSize(b);
  }
  // BITMAPINFOHEADER and later; a negative height is drawn top down.
  if (b.byteLength >= 26 && ascii(b, 0, 2) === "BM" && b.getUint32(14, true) >= 40) {
    return { width: Math.abs(b.getInt32(18, true)), height: Math.abs(b.getInt32(22, true)) };
  }
  return null;
}

/** Whether an image may be decoded, to be drawn or drawn smaller: its header tells a size not too big. */
export function decodable(bytes: Uint8Array): boolean {
  const size = pixelSizeOf(bytes);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width * size.height <= MAX_DECODED_PIXELS
  );
}

function ascii(b: DataView, from: number, to: number): string {
  let text = "";
  for (let at = from; at < to; at++) text += String.fromCharCode(b.getUint8(at));
  return text;
}

/** A little-endian unsigned integer of three bytes. */
function uint24(b: DataView, at: number): number {
  return b.getUint8(at) | (b.getUint8(at + 1) << 8) | (b.getUint8(at + 2) << 16);
}

/** A JPEG's frame size, from its first start-of-frame marker. */
function jpegSize(b: DataView): PixelSize | null {
  let at = 2;
  while (at + 9 < b.byteLength) {
    if (b.getUint8(at) !== 0xff) return null;
    const marker = b.getUint8(at + 1);
    // Fill bytes, and markers with no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = b.getUint16(at + 2);
    // SOF0..SOF15, but for DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.getUint16(at + 5), width: b.getUint16(at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** A WebP's canvas size: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webpSize(b: DataView): PixelSize | null {
  const chunk = ascii(b, 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + uint24(b, 24), height: 1 + uint24(b, 27) };
  }
  if (chunk === "VP8L" && b.getUint8(20) === 0x2f) {
    const bits = b.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (
    chunk === "VP8 " &&
    b.getUint8(23) === 0x9d &&
    b.getUint8(24) === 0x01 &&
    b.getUint8(25) === 0x2a
  ) {
    return { width: b.getUint16(26, true) & 0x3fff, height: b.getUint16(28, true) & 0x3fff };
  }
  return null;
}
