import { describe, expect, it } from "bun:test";
import { isPdfFile, nextZoomStep } from "../../../../../src/renderer/services/editor/preview/pdf";

describe("isPdfFile", () => {
  it("knows a PDF by its extension, case aside", () => {
    expect(isPdfFile("/w/a/paper.pdf")).toBe(true);
    expect(isPdfFile("/w/a/SCAN.PDF")).toBe(true);
    expect(isPdfFile("/w/a/pdf")).toBe(false);
    expect(isPdfFile("/w/a/notes.pdf.md")).toBe(false);
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
