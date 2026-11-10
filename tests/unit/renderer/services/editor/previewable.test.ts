import { describe, expect, it } from "bun:test";
import { isPreviewable } from "../../../../../src/renderer/services/editor/preview/previewable";

describe("isPreviewable", () => {
  it("singles out .mdx as mdx-disabled (preview refused for security)", () => {
    expect(isPreviewable("/r/doc.mdx")).toBe("mdx-disabled");
    expect(isPreviewable("/r/Doc.MDX")).toBe("mdx-disabled");
  });
});
