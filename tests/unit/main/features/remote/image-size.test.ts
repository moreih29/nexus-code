/** An image's size as its header says, read without decoding it. */
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  decodable,
  MAX_DECODED_PIXELS,
  pixelSizeOf,
} from "../../../../../src/main/features/remote/image-size";

/** A PNG header saying `width` by `height`, its pixels left out. */
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(16))),
  ]);
}

/** A JPEG with an APP0 segment, then a baseline start of frame. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([
    0xff,
    0xe0,
    0x00,
    0x10,
    ...Buffer.from("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const sof = Buffer.alloc(19);
  sof.set([0xff, 0xc0, 0x00, 0x11, 8]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function webpX(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

describe("an image's size, from its header", () => {
  test("PNG, JPEG, GIF and WebP", () => {
    expect(pixelSizeOf(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pixelSizeOf(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 });
    expect(pixelSizeOf(gif(32, 16))).toEqual({ width: 32, height: 16 });
    expect(pixelSizeOf(webpX(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  test("none for what does not say", () => {
    expect(pixelSizeOf(Buffer.from("not an image"))).toBeNull();
    expect(pixelSizeOf(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });

  test("decoded to be drawn smaller only when not too big, and known", () => {
    expect(decodable(jpeg(4032, 3024))).toBe(true);
    expect(decodable(png(8192, 6144))).toBe(true);
    expect(8192 * 6144).toBe(MAX_DECODED_PIXELS);
    // A small file that says it is 50000 by 50000.
    const bomb = png(50_000, 50_000);
    expect(bomb.length).toBeLessThan(100);
    expect(decodable(bomb)).toBe(false);
    expect(decodable(png(0, 10))).toBe(false);
    expect(decodable(Buffer.from("BM...."))).toBe(false);
  });
});
