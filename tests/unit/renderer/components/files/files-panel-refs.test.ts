/**
 * Unit tests for refsForGitGroup — the function that maps a git status group
 * and the isUnborn flag to leftRef/rightRef values used when opening a diff tab.
 *
 * Scope: all five behavioural branches of refsForGitGroup.
 *   1. staged + isUnborn=true  → leftRef === EMPTY_TREE
 *   2. staged + isUnborn=false → leftRef === "HEAD"
 *   3. working (any isUnborn)  → leftRef === "INDEX"  (unborn has no effect)
 *   4. default + isUnborn=true → leftRef === EMPTY_TREE
 *   5. default + isUnborn=false→ leftRef === "HEAD"
 *
 * Verification axis: refsForGitGroup is a pure function (no I/O, no React).
 * No mocks are needed for the function itself, but the module import chain
 * includes files-panel.tsx → useGitStore → git.ts, which calls
 * window.addEventListener at module load time.  A minimal window stub is
 * required so git.ts doesn't throw during module initialisation.
 */
import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Window stub — must precede dynamic imports that trigger git.ts module load.
// git.ts calls window.addEventListener("blur", ...) at module load time.
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
};

// ---------------------------------------------------------------------------
// Module imports — AFTER window stub (dynamic import to respect init order).
// ---------------------------------------------------------------------------

const { EMPTY_TREE } = await import("../../../../../src/renderer/components/editor/diff-refs");
const { refsForGitGroup } = await import(
  "../../../../../src/renderer/components/files/files-panel"
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("refsForGitGroup", () => {
  describe("staged group", () => {
    test("isUnborn=true → leftRef is EMPTY_TREE (no IPC call for unborn repo)", () => {
      const refs = refsForGitGroup("staged", true);
      expect(refs.leftRef).toBe(EMPTY_TREE);
      expect(refs.rightRef).toBe("INDEX");
    });

    test("isUnborn=false → leftRef is HEAD (normal repo)", () => {
      const refs = refsForGitGroup("staged", false);
      expect(refs.leftRef).toBe("HEAD");
      expect(refs.rightRef).toBe("INDEX");
    });
  });

  describe("working group", () => {
    test("isUnborn=true → leftRef is INDEX (working diff is always INDEX vs WORKING)", () => {
      const refs = refsForGitGroup("working", true);
      expect(refs.leftRef).toBe("INDEX");
      expect(refs.rightRef).toBe("WORKING");
    });

    test("isUnborn=false → leftRef is INDEX", () => {
      const refs = refsForGitGroup("working", false);
      expect(refs.leftRef).toBe("INDEX");
      expect(refs.rightRef).toBe("WORKING");
    });
  });

  describe("default group (merge / untracked)", () => {
    test("isUnborn=true → leftRef is EMPTY_TREE", () => {
      const refs = refsForGitGroup("untracked", true);
      expect(refs.leftRef).toBe(EMPTY_TREE);
      expect(refs.rightRef).toBe("WORKING");
    });

    test("isUnborn=false → leftRef is HEAD", () => {
      const refs = refsForGitGroup("merge", false);
      expect(refs.leftRef).toBe("HEAD");
      expect(refs.rightRef).toBe("WORKING");
    });
  });
});
