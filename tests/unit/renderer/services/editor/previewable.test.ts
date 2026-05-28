import { describe, expect, it } from "bun:test";
import {
  isImageFile,
  isPreviewable,
  previewEngineFor,
} from "../../../../../src/renderer/services/editor/preview/previewable";

describe("isPreviewable", () => {
  it("classifies markdown files as supported (case-insensitive)", () => {
    expect(isPreviewable("/r/README.md")).toBe("supported");
    expect(isPreviewable("/r/README.MD")).toBe("supported");
    expect(isPreviewable("/r/notes.markdown")).toBe("supported");
  });

  it("classifies html files as supported", () => {
    expect(isPreviewable("/r/index.html")).toBe("supported");
    expect(isPreviewable("/r/page.htm")).toBe("supported");
  });

  it("classifies svg files as supported", () => {
    expect(isPreviewable("/r/logo.svg")).toBe("supported");
  });

  it("singles out .mdx as mdx-disabled (preview refused for security)", () => {
    expect(isPreviewable("/r/doc.mdx")).toBe("mdx-disabled");
    expect(isPreviewable("/r/Doc.MDX")).toBe("mdx-disabled");
  });

  it("returns none for non-previewable files", () => {
    expect(isPreviewable("/r/index.ts")).toBe("none");
    expect(isPreviewable("/r/Makefile")).toBe("none");
    expect(isPreviewable("/r/no-extension")).toBe("none");
    expect(isPreviewable("/r/photo.png")).toBe("none");
  });
});

describe("previewEngineFor", () => {
  it("maps each supported extension to its engine", () => {
    expect(previewEngineFor("/r/README.md")).toBe("markdown");
    expect(previewEngineFor("/r/notes.markdown")).toBe("markdown");
    expect(previewEngineFor("/r/index.html")).toBe("html");
    expect(previewEngineFor("/r/page.htm")).toBe("html");
    expect(previewEngineFor("/r/logo.svg")).toBe("svg");
  });

  it("throws on non-previewable paths (defensive — callers must filter)", () => {
    expect(() => previewEngineFor("/r/index.ts")).toThrow();
  });
});

describe("isImageFile", () => {
  it("recognizes raster image extensions (case-insensitive)", () => {
    expect(isImageFile("/r/photo.png")).toBe(true);
    expect(isImageFile("/r/photo.JPG")).toBe(true);
    expect(isImageFile("/r/photo.jpeg")).toBe(true);
    expect(isImageFile("/r/anim.gif")).toBe(true);
    expect(isImageFile("/r/cover.webp")).toBe(true);
    expect(isImageFile("/r/pixel.bmp")).toBe(true);
    expect(isImageFile("/r/favicon.ico")).toBe(true);
    expect(isImageFile("/r/modern.avif")).toBe(true);
  });

  it("excludes .svg (handled by the existing SVG preview path)", () => {
    expect(isImageFile("/r/logo.svg")).toBe(false);
  });

  it("returns false for non-image files", () => {
    expect(isImageFile("/r/index.ts")).toBe(false);
    expect(isImageFile("/r/README.md")).toBe(false);
    expect(isImageFile("/r/no-extension")).toBe(false);
  });
});
