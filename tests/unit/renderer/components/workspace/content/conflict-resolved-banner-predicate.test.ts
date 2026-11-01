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
  test.each([
    // isConflicted, hasMarkers, expected
    [true, false, true], // last block resolved, markResolved not yet run
    [true, true, false], // partial resolution: the CodeLens handles this state
    [false, false, false], // normal file or already markResolved
    [false, true, false], // conflict-like text in a file outside the merge group
  ])("isConflicted=%p hasMarkers=%p → %p", (isConflicted, hasMarkers, expected) => {
    expect(shouldShowConflictResolvedBanner(isConflicted, hasMarkers)).toBe(expected);
  });
});
