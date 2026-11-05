import { describe, expect, it } from "bun:test";
import { bytesFromBase64 } from "../../../../../src/renderer/services/editor/preview/read-binary";

describe("bytesFromBase64", () => {
  it("gives the bytes back, high ones included", () => {
    expect([...bytesFromBase64("JVBERi0=")]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect([...bytesFromBase64("AP+A")]).toEqual([0x00, 0xff, 0x80]);
    expect(bytesFromBase64("").length).toBe(0);
  });
});
