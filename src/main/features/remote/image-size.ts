/**
 * An image's size in pixels as its header says, read without decoding it:
 * a small file can say it is huge (a decompression bomb), and drawing it
 * smaller would decode all of it on the main process first. PNG, JPEG, GIF
 * and WebP, as files.read draws them; null for one whose header does not
 * tell.
 */

/** The most pixels an image is decoded with to be drawn smaller: 8K by 6K. */
export const MAX_DECODED_PIXELS = 8192 * 6144;

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

export function pixelSizeOf(bytes: Uint8Array): PixelSize | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    b.length >= 24 &&
    b.readUInt32BE(0) === 0x89504e47 &&
    b.toString("ascii", 12, 16) === "IHDR"
  ) {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b);
  if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return webpSize(b);
  }
  return null;
}

/** A JPEG's frame size, from its first start-of-frame marker. */
function jpegSize(b: Buffer): PixelSize | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1] as number;
    // Fill bytes, and markers with no length.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = b.readUInt16BE(at + 2);
    // SOF0..SOF15, but for DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    if (length < 2) return null;
    at += 2 + length;
  }
  return null;
}

/** A WebP's canvas size: lossy (VP8), lossless (VP8L) or extended (VP8X). */
function webpSize(b: Buffer): PixelSize | null {
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X") {
    return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === "VP8L" && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

/** Whether an image may be decoded to be drawn smaller: its header tells a size not too big. */
export function decodable(bytes: Uint8Array): boolean {
  const size = pixelSizeOf(bytes);
  return (
    size !== null &&
    size.width > 0 &&
    size.height > 0 &&
    size.width * size.height <= MAX_DECODED_PIXELS
  );
}
