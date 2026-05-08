import { describe, expect, test } from "bun:test";
import { isBinaryProbe } from "../../../../src/main/filesystem/binary-detect";

describe("isBinaryProbe", () => {
  test("empty buffer → false", () => {
    expect(isBinaryProbe(Buffer.alloc(0))).toBe(false);
  });

  test("pure ASCII text → false", () => {
    expect(isBinaryProbe(Buffer.from("hello world\n"))).toBe(false);
  });

  test("UTF-8 BOM (EF BB BF) followed by ASCII → false (UTF-8 BOM does not trigger binary path)", () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hello")]);
    expect(isBinaryProbe(buf)).toBe(false);
  });

  test("UTF-16 LE BOM (FF FE) → true", () => {
    const buf = Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    expect(isBinaryProbe(buf)).toBe(true);
  });

  test("UTF-16 BE BOM (FE FF) → true", () => {
    const buf = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(isBinaryProbe(buf)).toBe(true);
  });

  test("ASCII text with a single NUL byte in the first 512 bytes → true", () => {
    const buf = Buffer.alloc(100, 0x41); // 'A' * 100
    buf[50] = 0x00;
    expect(isBinaryProbe(buf)).toBe(true);
  });

  test("ASCII text with NUL past byte 512 → false (512-byte cutoff honored)", () => {
    // 600 bytes: first 600 are 'A', then set byte 513 to NUL
    const buf = Buffer.alloc(600, 0x41);
    buf[513] = 0x00;
    expect(isBinaryProbe(buf)).toBe(false);
  });

  test("PNG magic header followed by zeros → true (NUL inside probe window)", () => {
    const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const rest = Buffer.alloc(100, 0x00);
    const buf = Buffer.concat([header, rest]);
    expect(isBinaryProbe(buf)).toBe(true);
  });
});
