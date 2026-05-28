/**
 * Phase F — revealEditorActiveFile unit tests.
 *
 * Covers the selection policy:
 *   - file in selection.paths → setFocus (preserves multi-select).
 *   - file not in selection.paths → setSingleSelection (replaces selection).
 *   - no selection for workspace → setSingleSelection.
 *   - workspace tree absent → no-op (no crash).
 */

import { beforeEach, describe, expect, it } from "bun:test";

// ---------------------------------------------------------------------------
// Shims
// ---------------------------------------------------------------------------

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { revealEditorActiveFile } from "../../../../../src/renderer/state/operations/files";
import {
  selectFocus,
  selectIsSelected,
  useFilesStore,
} from "../../../../../src/renderer/state/stores/files";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-reveal-test";
const FILE_A = "/repo/a.ts";
const FILE_B = "/repo/b.ts";
const FILE_C = "/repo/c.ts";

function resetStore(): void {
  useFilesStore.setState({ trees: new Map(), selection: new Map() });
}

beforeEach(resetStore);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("revealEditorActiveFile — file in selection.paths", () => {
  it("moves focus to activeFile without clearing the selection set", () => {
    // Setup: b.ts and c.ts selected, focus on b.ts.
    useFilesStore.getState().selectAllVisible(WS, [FILE_A, FILE_B, FILE_C]);
    // Confirm all three are selected.
    expect(selectIsSelected(useFilesStore.getState(), WS, FILE_B)).toBe(true);
    expect(selectIsSelected(useFilesStore.getState(), WS, FILE_C)).toBe(true);

    // Activate b.ts (already in selection) → only focus moves.
    revealEditorActiveFile(WS, FILE_B);

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(FILE_B);
    // Selection set must be preserved — a.ts and c.ts still selected.
    expect(selectIsSelected(s, WS, FILE_A)).toBe(true);
    expect(selectIsSelected(s, WS, FILE_C)).toBe(true);
  });
});

describe("revealEditorActiveFile — file NOT in selection.paths", () => {
  it("single-selects the activeFile, clearing any prior selection", () => {
    // Setup: a.ts and b.ts selected.
    useFilesStore.getState().selectAllVisible(WS, [FILE_A, FILE_B]);

    // Activate c.ts (not in selection) → single-select replaces.
    revealEditorActiveFile(WS, FILE_C);

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(FILE_C);
    // Prior selection cleared.
    expect(selectIsSelected(s, WS, FILE_A)).toBe(false);
    expect(selectIsSelected(s, WS, FILE_B)).toBe(false);
    // paths should be empty (single-selection has empty paths set).
    expect(selectIsSelected(s, WS, FILE_C)).toBe(false);
  });
});

describe("revealEditorActiveFile — no prior selection", () => {
  it("single-selects when no selection exists for workspace", () => {
    revealEditorActiveFile(WS, FILE_A);

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(FILE_A);
  });
});

describe("revealEditorActiveFile — empty paths set (focus-only selection)", () => {
  it("single-selects when paths is empty (focus row, not in set)", () => {
    // setSingleSelection → focus=FILE_A, paths={}.
    useFilesStore.getState().setSingleSelection(WS, FILE_A);

    // Activate b.ts — paths is empty so FILE_A is not "in selection.paths".
    revealEditorActiveFile(WS, FILE_B);

    const s = useFilesStore.getState();
    expect(selectFocus(s, WS)).toBe(FILE_B);
  });
});
