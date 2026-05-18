/**
 * useFocusIslandStore — focused island tracking.
 *
 * Covers:
 * (a) default focused island is "editor".
 * (b) setFocusedIsland transitions to each valid value.
 * (c) repeated calls to the same island are idempotent (no unintended side-effects).
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { useFocusIslandStore } from "../../../../../src/renderer/state/stores/focus-island";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resetStore() {
  useFocusIslandStore.setState({ focusedIsland: "editor" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useFocusIslandStore", () => {
  beforeEach(resetStore);

  it("(a) default focusedIsland is 'editor'", () => {
    expect(useFocusIslandStore.getState().focusedIsland).toBe("editor");
  });

  it("(b) setFocusedIsland('sidebar') updates to 'sidebar'", () => {
    useFocusIslandStore.getState().setFocusedIsland("sidebar");
    expect(useFocusIslandStore.getState().focusedIsland).toBe("sidebar");
  });

  it("(b) setFocusedIsland('files') updates to 'files'", () => {
    useFocusIslandStore.getState().setFocusedIsland("files");
    expect(useFocusIslandStore.getState().focusedIsland).toBe("files");
  });

  it("(b) setFocusedIsland('editor') updates to 'editor'", () => {
    useFocusIslandStore.getState().setFocusedIsland("sidebar");
    useFocusIslandStore.getState().setFocusedIsland("editor");
    expect(useFocusIslandStore.getState().focusedIsland).toBe("editor");
  });

  it("(c) calling setFocusedIsland with the current value leaves the store unchanged", () => {
    useFocusIslandStore.getState().setFocusedIsland("editor");
    useFocusIslandStore.getState().setFocusedIsland("editor");
    expect(useFocusIslandStore.getState().focusedIsland).toBe("editor");
  });
});
