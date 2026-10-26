import { describe, expect, test } from "bun:test";

const { headBaselineSignature } = await import(
  "../../../../../../../src/renderer/components/workspace/content/editor-mount/install-dirty-diff"
);
const { GitStatusSchema } = await import("../../../../../../../src/shared/git/types");

function status(overrides: Record<string, unknown> = {}) {
  return GitStatusSchema.parse({
    merge: [],
    staged: [],
    working: [],
    untracked: [],
    branch: { current: "main", isUnborn: false },
    capabilities: { hasHEAD: true, remotes: [], stashCount: 0 },
    ...overrides,
  });
}

describe("headBaselineSignature", () => {
  test("ignores status churn in other files", () => {
    const before = status({ working: [{ relPath: "other.ts", xy: ".M" }] });
    const after = status({
      working: [
        { relPath: "other.ts", xy: ".M" },
        { relPath: "new.ts", xy: ".M" },
      ],
    });
    expect(headBaselineSignature(after, "src/a.ts")).toBe(
      headBaselineSignature(before, "src/a.ts"),
    );
  });

  test("changes when the file's own entry changes (commit, reset --soft)", () => {
    const dirty = status({ working: [{ relPath: "src/a.ts", xy: ".M" }] });
    const clean = status();
    expect(headBaselineSignature(dirty, "src/a.ts")).not.toBe(
      headBaselineSignature(clean, "src/a.ts"),
    );
  });

  test("changes when the branch changes", () => {
    const other = status({ branch: { current: "feature", isUnborn: false } });
    expect(headBaselineSignature(other, "src/a.ts")).not.toBe(
      headBaselineSignature(status(), "src/a.ts"),
    );
  });
});
