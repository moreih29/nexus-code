import { describe, expect, it } from "bun:test";
import {
  bytesFromBase64,
  isPdfFile,
  nextZoomStep,
} from "../../../../../src/renderer/services/editor/preview/pdf";

describe("isPdfFile", () => {
  it("knows a PDF by its extension, case aside", () => {
    expect(isPdfFile("/w/a/paper.pdf")).toBe(true);
    expect(isPdfFile("/w/a/SCAN.PDF")).toBe(true);
    expect(isPdfFile("/w/a/pdf")).toBe(false);
    expect(isPdfFile("/w/a/notes.pdf.md")).toBe(false);
  });
});

describe("bytesFromBase64", () => {
  it("gives the bytes back, high ones included", () => {
    expect([...bytesFromBase64("JVBERi0=")]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect([...bytesFromBase64("AP+A")]).toEqual([0x00, 0xff, 0x80]);
    expect(bytesFromBase64("").length).toBe(0);
  });
});

describe("nextZoomStep", () => {
  it("goes to the next step either way", () => {
    expect(nextZoomStep(1, 1)).toBe(1.25);
    expect(nextZoomStep(1, -1)).toBe(0.75);
  });

  it("goes from a scale between steps to the nearest one that way", () => {
    expect(nextZoomStep(0.4, 1)).toBe(0.5);
    expect(nextZoomStep(0.4, -1)).toBe(0.25);
    expect(nextZoomStep(1.2499, 1)).toBe(1.5);
  });

  it("stays at either end", () => {
    expect(nextZoomStep(4, 1)).toBe(4);
    expect(nextZoomStep(0.25, -1)).toBe(0.25);
    expect(nextZoomStep(6, 1)).toBe(6);
  });
});
