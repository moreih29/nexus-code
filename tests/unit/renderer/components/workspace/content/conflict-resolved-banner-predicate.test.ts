/**
 * conflict-resolved-banner — predicate aspect unit tests.
 *
 * Verifies `shouldShowConflictResolvedBanner` for all combinations of the
 * two boolean inputs:
 *
 *   isConflicted  — git still reports this file in the merge group
 *   hasMarkers    — the editor buffer contains `<<<<<<<` conflict markers
 *
 * The banner should appear only when the file is still git-conflicted AND the
 * buffer no longer contains markers (the user resolved the last block but has
 * not yet run markResolved).
 *
 * No Monaco, React, or IPC dependencies — the predicate is pure data.
 */

import { describe, expect, test } from "bun:test";
import { shouldShowConflictResolvedBanner } from "../../../../../../src/renderer/components/workspace/content/conflict-resolved-banner";

describe("shouldShowConflictResolvedBanner", () => {
  test("returns true when git-conflicted and no markers remain", () => {
    expect(shouldShowConflictResolvedBanner(true, false)).toBe(true);
  });

  test("returns false when git-conflicted but markers still present", () => {
    // Partial resolution: the CodeLens handles this state, not the banner.
    expect(shouldShowConflictResolvedBanner(true, true)).toBe(false);
  });

  test("returns false when not git-conflicted and no markers remain", () => {
    // Normal file or already markResolved: banner must not appear.
    expect(shouldShowConflictResolvedBanner(false, false)).toBe(false);
  });

  test("returns false when not git-conflicted and markers present", () => {
    // Edge case: file has conflict-like text but is not in the merge group.
    expect(shouldShowConflictResolvedBanner(false, true)).toBe(false);
  });
});
