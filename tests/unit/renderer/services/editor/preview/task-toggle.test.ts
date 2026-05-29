import { describe, expect, test } from "bun:test";
import { toggleTaskMarker } from "../../../../../../src/renderer/services/editor/preview/task-toggle";

describe("toggleTaskMarker", () => {
  test("unchecked → checked for a dash bullet", () => {
    expect(toggleTaskMarker("- [ ] buy milk")).toBe("- [x] buy milk");
  });

  test("checked → unchecked", () => {
    expect(toggleTaskMarker("- [x] done")).toBe("- [ ] done");
  });

  test("uppercase X is treated as checked and clears to a space", () => {
    expect(toggleTaskMarker("- [X] done")).toBe("- [ ] done");
  });

  test("preserves leading indentation of nested items", () => {
    expect(toggleTaskMarker("    - [ ] nested")).toBe("    - [x] nested");
  });

  test("supports * and + bullets", () => {
    expect(toggleTaskMarker("* [ ] star")).toBe("* [x] star");
    expect(toggleTaskMarker("+ [ ] plus")).toBe("+ [x] plus");
  });

  test("supports ordered list markers (1. and 1))", () => {
    expect(toggleTaskMarker("1. [ ] first")).toBe("1. [x] first");
    expect(toggleTaskMarker("2) [x] second")).toBe("2) [ ] second");
  });

  test("only the leading checkbox is flipped, trailing [ ] in text is untouched", () => {
    expect(toggleTaskMarker("- [ ] see [ ] later")).toBe("- [x] see [ ] later");
  });

  test("returns null for a plain bullet (no checkbox)", () => {
    expect(toggleTaskMarker("- plain item")).toBeNull();
  });

  test("returns null for a non-list line", () => {
    expect(toggleTaskMarker("just a paragraph [ ]")).toBeNull();
  });

  test("returns null for a fenced/indented checkbox without a list marker", () => {
    expect(toggleTaskMarker("[ ] no marker")).toBeNull();
  });
});
