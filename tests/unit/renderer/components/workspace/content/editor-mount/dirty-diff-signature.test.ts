import { describe, expect, test } from "bun:test";

const { baselineSignature, hasStagedChanges, isUnchangedInStatus } = await import(
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

describe("baselineSignature", () => {
  test("ignores status churn in other files", () => {
    const before = status({ working: [{ relPath: "other.ts", xy: ".M" }] });
    const after = status({
      working: [
        { relPath: "other.ts", xy: ".M" },
        { relPath: "new.ts", xy: ".M" },
      ],
    });
    expect(baselineSignature(after, "src/a.ts")).toBe(baselineSignature(before, "src/a.ts"));
  });

  test("changes when the file's own entry changes (stage, commit, reset)", () => {
    const dirty = status({ working: [{ relPath: "src/a.ts", xy: ".M" }] });
    const clean = status();
    expect(baselineSignature(dirty, "src/a.ts")).not.toBe(baselineSignature(clean, "src/a.ts"));
  });

  test("changes when the branch changes", () => {
    const other = status({ branch: { current: "feature", isUnborn: false } });
    expect(baselineSignature(other, "src/a.ts")).not.toBe(baselineSignature(status(), "src/a.ts"));
  });
});

describe("hasStagedChanges", () => {
  test("holds while the file has an index entry that differs from HEAD", () => {
    const partly = status({
      staged: [{ relPath: "src/a.ts", xy: "MM" }],
      working: [{ relPath: "src/a.ts", xy: "MM" }],
    });
    expect(hasStagedChanges(partly, "src/a.ts")).toBe(true);
    expect(hasStagedChanges(partly, "src/b.ts")).toBe(false);
    expect(
      hasStagedChanges(status({ working: [{ relPath: "src/a.ts", xy: ".M" }] }), "src/a.ts"),
    ).toBe(false);
  });
});

describe("isUnchangedInStatus", () => {
  test("holds only while the file has no entry at all", () => {
    expect(isUnchangedInStatus(status(), "src/a.ts")).toBe(true);
    expect(
      isUnchangedInStatus(status({ working: [{ relPath: "other.ts", xy: ".M" }] }), "src/a.ts"),
    ).toBe(true);
    for (const key of ["merge", "staged", "working", "untracked"]) {
      const entry = { relPath: "src/a.ts", xy: key === "untracked" ? "??" : ".M" };
      expect(isUnchangedInStatus(status({ [key]: [entry] }), "src/a.ts")).toBe(false);
    }
    const renamed = status({ staged: [{ relPath: "src/b.ts", oldRelPath: "src/a.ts", xy: "R." }] });
    expect(isUnchangedInStatus(renamed, "src/a.ts")).toBe(false);
    expect(isUnchangedInStatus(status(), null)).toBe(false);
  });
});
