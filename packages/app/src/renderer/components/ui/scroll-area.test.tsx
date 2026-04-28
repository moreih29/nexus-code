import { describe, expect, test } from "bun:test";

import { ScrollArea, ScrollBar } from "./scroll-area";

describe("ScrollArea", () => {
  test("uses a native viewport rather than Radix stateful ref plumbing", () => {
    const tree = ScrollArea({
      className: "h-full",
      "data-test-id": "scroll-root",
      children: <span>Content</span>,
    });

    expect(tree.type).toBe("div");
    expect(tree.props["data-slot"]).toBe("scroll-area");
    expect(tree.props["data-test-id"]).toBe("scroll-root");
    expect(tree.props.className).toContain("overflow-hidden");
    expect(tree.props.className).toContain("h-full");

    const viewport = tree.props.children;
    expect(viewport.type).toBe("div");
    expect(viewport.props["data-slot"]).toBe("scroll-area-viewport");
    expect(viewport.props.className).toContain("overflow-auto");
  });

  test("keeps the legacy ScrollBar export as a no-op for compatibility", () => {
    expect(ScrollBar({})).toBeNull();
  });
});
