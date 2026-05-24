import { describe, expect, it } from "bun:test";
import {
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
