import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetDirtyTrackerForTests,
  attachDirtyTracker,
  detachDirtyTracker,
  getDirtyEntry,
  isDirty,
  markSaved,
  subscribeTransitions,
  updateLoadedMetadata,
} from "../../../../../src/renderer/services/editor/dirty-tracker";

// Minimal Monaco model stub. Only the surface dirty-tracker actually uses.
function makeModel(initialAltId = 1) {
  let altId = initialAltId;
  const listeners = new Set<() => void>();
  return {
    getAlternativeVersionId: () => altId,
    onDidChangeContent: (cb: () => void) => {
      listeners.add(cb);
      return {
        dispose: () => {
          listeners.delete(cb);
        },
      };
    },
    /** Simulate an edit. New altId reflects user-initiated change. */
    edit(nextAltId: number) {
      altId = nextAltId;
      for (const cb of listeners) cb();
    },
  };
}

afterEach(() => __resetDirtyTrackerForTests());

describe("dirty-tracker", () => {
  it("starts clean and stays clean while alt id matches saved baseline", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    expect(isDirty("file:///a")).toBe(false);
  });

  it("becomes dirty on first content change with a different alt id", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    model.edit(6);
    expect(isDirty("file:///a")).toBe(true);
  });

  it("returns to clean if the user undoes back to the saved alt id", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    model.edit(6); // dirty
    expect(isDirty("file:///a")).toBe(true);
    model.edit(5); // undo back to saved alt
    expect(isDirty("file:///a")).toBe(false);
  });

  it("emits transition events only on flips, not on every edit", () => {
    const events: Array<{ cacheUri: string; isDirty: boolean }> = [];
    subscribeTransitions((e) => events.push(e));

    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    model.edit(6); // false → true
    model.edit(7); // still dirty, no flip
    model.edit(8); // still dirty, no flip
    model.edit(5); // true → false (undo)

    expect(events).toEqual([
      { cacheUri: "file:///a", isDirty: true },
      { cacheUri: "file:///a", isDirty: false },
    ]);
  });

  it("markSaved updates the saved baseline and metadata, clearing dirty if alt id matches", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    model.edit(6); // dirty
    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 6,
      loadedMtime: "T1",
      loadedSize: 20,
    });
    expect(isDirty("file:///a")).toBe(false);
    const entry = getDirtyEntry("file:///a");
    expect(entry?.loadedMtime).toBe("T1");
    expect(entry?.loadedSize).toBe(20);
  });

  it("markSaved keeps dirty=true when user edited past the version that was saved", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    model.edit(6); // user typed → dirty, save started capturing alt=6
    model.edit(7); // user typed more during save
    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 6,
      loadedMtime: "T1",
      loadedSize: 20,
    });
    // Saved baseline is now 6, but model is at 7 → still dirty.
    expect(isDirty("file:///a")).toBe(true);
  });

  it("updateLoadedMetadata changes mtime/size but does not change dirty state", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    model.edit(6);
    updateLoadedMetadata("file:///a", "T-EXTERNAL", 99);
    expect(isDirty("file:///a")).toBe(true);
    const entry = getDirtyEntry("file:///a");
    expect(entry?.loadedMtime).toBe("T-EXTERNAL");
    expect(entry?.loadedSize).toBe(99);
  });

  it("detach disposes the content listener and removes the entry", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    detachDirtyTracker("file:///a");
    expect(getDirtyEntry("file:///a")).toBeUndefined();

    // After detach, edits don't update tracker state.
    const events: Array<{ cacheUri: string; isDirty: boolean }> = [];
    subscribeTransitions((e) => events.push(e));
    model.edit(6);
    expect(events).toEqual([]);
  });

  it("attach is idempotent for the same cacheUri", () => {
    const model = makeModel(5);
    const e1 = attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    const e2 = attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T999",
      loadedSize: 999,
    });
    expect(e1).toBe(e2);
    // First-attach metadata is preserved (later attach is a no-op).
    expect(e1.loadedMtime).toBe("T0");
  });
});
