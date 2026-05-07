import { afterEach, describe, expect, it } from "bun:test";
import {
  __resetDirtyTrackerForTests,
  attachDirtyTracker,
  markSaved,
  subscribeSaved,
} from "../../../../src/renderer/services/editor/dirty-tracker";

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
    edit(nextAltId: number) {
      altId = nextAltId;
      for (const cb of listeners) cb();
    },
  };
}

afterEach(() => __resetDirtyTrackerForTests());

describe("dirty-tracker subscribeSaved", () => {
  it("fires the listener when markSaved is called", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const events: Array<{ cacheUri: string }> = [];
    subscribeSaved((e) => events.push(e));

    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    expect(events).toEqual([{ cacheUri: "file:///a" }]);
  });

  it("fires the correct cacheUri when multiple files are tracked", () => {
    const modelA = makeModel(5);
    const modelB = makeModel(10);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: modelA as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });
    attachDirtyTracker({
      cacheUri: "file:///b",
      model: modelB as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const events: Array<{ cacheUri: string }> = [];
    subscribeSaved((e) => events.push(e));

    markSaved({
      cacheUri: "file:///b",
      model: modelB as never,
      savedAlternativeVersionId: 10,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    expect(events).toEqual([{ cacheUri: "file:///b" }]);
  });

  it("notifies multiple listeners in the same markSaved call", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const calls1: string[] = [];
    const calls2: string[] = [];
    subscribeSaved((e) => calls1.push(e.cacheUri));
    subscribeSaved((e) => calls2.push(e.cacheUri));

    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    expect(calls1).toEqual(["file:///a"]);
    expect(calls2).toEqual(["file:///a"]);
  });

  it("dispose removes the listener so it no longer fires", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const events: Array<{ cacheUri: string }> = [];
    const dispose = subscribeSaved((e) => events.push(e));

    dispose();

    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    expect(events).toHaveLength(0);
  });

  it("listener removed during iteration does not break the current forEach", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const calls: string[] = [];
    let disposeSecond!: () => void;

    // First listener removes the second listener while iterating.
    subscribeSaved(() => {
      calls.push("first");
      disposeSecond();
    });
    disposeSecond = subscribeSaved(() => {
      calls.push("second");
    });

    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    // Array.from snapshot means second was already removed from set but captured in snapshot,
    // so whether it fires depends on snapshot order. The important thing is no exception thrown
    // and "first" always fires.
    expect(calls).toContain("first");
  });

  it("listener added during iteration does not fire in the current markSaved call", () => {
    const model = makeModel(5);
    attachDirtyTracker({
      cacheUri: "file:///a",
      model: model as never,
      loadedMtime: "T0",
      loadedSize: 10,
    });

    const calls: string[] = [];

    subscribeSaved(() => {
      calls.push("original");
      // add a new listener mid-iteration
      subscribeSaved(() => {
        calls.push("added-during");
      });
    });

    markSaved({
      cacheUri: "file:///a",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    // Array.from snapshot taken before iteration: "added-during" should NOT appear this call.
    expect(calls).toEqual(["original"]);
  });

  it("does not fire when markSaved is called for an unknown cacheUri", () => {
    const events: Array<{ cacheUri: string }> = [];
    subscribeSaved((e) => events.push(e));

    // markSaved with no attached entry is a no-op — no notification expected.
    const model = makeModel(5);
    markSaved({
      cacheUri: "file:///unknown",
      model: model as never,
      savedAlternativeVersionId: 5,
      loadedMtime: "T1",
      loadedSize: 20,
    });

    expect(events).toHaveLength(0);
  });
});
