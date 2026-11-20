import { describe, expect, test } from "bun:test";
import { resolveRename } from "../../../../src/renderer/components/workbench/workspace-rename";

describe("resolveRename", () => {
  test("returns the trimmed new name", () => {
    expect(resolveRename("  beta ", "alpha")).toBe("beta");
  });
  test("ignores an empty draft", () => {
    expect(resolveRename("   ", "alpha")).toBeNull();
  });
  test("ignores the same name", () => {
    expect(resolveRename(" alpha", "alpha")).toBeNull();
  });
});
