// Tests for diskDiverged tracking in ModelEntry:
//   - reconcileExternalChange records diskDiverged when buffer is dirty
//   - reconcileExternalChange clears diskDiverged on clean reload
//   - reloadEntryFromDisk always replaces buffer and clears diskDiverged
//
// We inject deps directly to avoid touching the real dirty-tracker, file-loader,
// or Monaco singleton — keeping this test self-contained and fast.

import { describe, expect, test } from "bun:test";
import {
  reconcileExternalChange,
  reloadEntryFromDisk,
  snapshot,
} from "../../../../../src/renderer/services/editor/model/entry";
import type { ModelEntry, ModelEntryDeps } from "../../../../../src/renderer/services/editor/model/entry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Monaco model stub — only the surface entry.ts reads.
 */
function makeModel(value: string) {
  let content = value;
  return {
    getValue: () => content,
    setValue: (next: string) => {
      content = next;
    },
    isDisposed: () => false,
    getAlternativeVersionId: () => 1,
  };
}

/**
 * Build a stub deps bag. `readFileForModel` can be overridden per test.
 */
function makeDeps(overrides: Partial<ModelEntryDeps> = {}): ModelEntryDeps {
  return {
    attachDirtyTracker: () => ({
      isDirty: false,
      savedAlternativeVersionId: 1,
      loadedMtime: "T0",
      loadedSize: 10,
      contentDisposable: { dispose: () => {} },
    }),
    detachDirtyTracker: () => {},
    markDirtyTrackerSaved: () => {},
    readFileForModel: () =>
      Promise.resolve({
        content: "disk-content",
        mtime: "T-disk",
        sizeBytes: 42,
        isBinary: false,
      }),
    subscribeFsChanged: () => () => {},
    workspaceRootForInput: () => "/workspace",
    isLspLanguage: () => false,
    ensureProvidersFor: () => {},
    monacoContentChangesToLsp: () => [],
    notifyDidChange: () => Promise.resolve(),
    notifyDidClose: () => Promise.resolve(),
    notifyDidOpen: () => Promise.resolve(),
    registerKnownModelUri: () => {},
    unregisterKnownModelUri: () => {},
    requireMonaco: () =>
      ({
        Uri: { parse: (s: string) => ({ toString: () => s }) },
      }) as never,
    ...overrides,
  };
}

/**
 * Build a minimal ModelEntry that is already in the "ready" phase so
 * reconcileExternalChange / reloadEntryFromDisk can run their full body.
 */
function makeEntry(
  modelValue: string,
  lastLoadedValue: string,
  deps: ModelEntryDeps,
): ModelEntry {
  const model = makeModel(modelValue);
  return {
    input: { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" },
    cacheUri: "file:///workspace/src/a.ts",
    lspUri: "file:///workspace/src/a.ts",
    monacoUri: { toString: () => "file:///workspace/src/a.ts" } as never,
    languageId: "typescript",
    refCount: 1,
    version: 1,
    phase: "ready",
    model: model as never,
    lastLoadedValue,
    loadPromise: Promise.resolve(),
    lspOpened: false,
    disposed: false,
    subscribers: new Set(),
    origin: "workspace",
    readOnly: false,
    deps,
  };
}

// ---------------------------------------------------------------------------
// reconcileExternalChange — dirty buffer (dirty bail path)
// ---------------------------------------------------------------------------

describe("reconcileExternalChange — dirty buffer", () => {
  test("records diskDiverged with disk mtime/size and notifies subscribers", async () => {
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: "disk-new-content",
          mtime: "T-new",
          sizeBytes: 99,
          isBinary: false,
        }),
    });

    // Buffer value differs from lastLoadedValue → simulates dirty edits
    const entry = makeEntry("edited-by-user", "original-from-disk", deps);

    let notified = false;
    entry.subscribers.add(() => {
      notified = true;
    });

    await reconcileExternalChange(entry);

    expect(entry.diskDiverged).toEqual({ mtime: "T-new", size: 99 });
    expect(notified).toBe(true);
    // Buffer must not be touched
    expect(entry.model?.getValue()).toBe("edited-by-user");
    // lastLoadedValue must not be updated
    expect(entry.lastLoadedValue).toBe("original-from-disk");
  });

  test("snapshot exposes diskDiverged after dirty bail", async () => {
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: "new-disk",
          mtime: "T2",
          sizeBytes: 55,
          isBinary: false,
        }),
    });

    const entry = makeEntry("user-edit", "base", deps);
    await reconcileExternalChange(entry);

    const snap = snapshot(entry);
    expect(snap.diskDiverged).toEqual({ mtime: "T2", size: 55 });
  });
});

// ---------------------------------------------------------------------------
// reconcileExternalChange — clean buffer (non-dirty reload path)
// ---------------------------------------------------------------------------

describe("reconcileExternalChange — clean buffer", () => {
  test("clears diskDiverged and updates buffer when buffer matches lastLoadedValue", async () => {
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: "new-from-disk",
          mtime: "T-fresh",
          sizeBytes: 77,
          isBinary: false,
        }),
    });

    // Buffer matches lastLoadedValue → not dirty
    const entry = makeEntry("same-content", "same-content", deps);
    // Pre-set a stale diskDiverged to verify it gets cleared
    entry.diskDiverged = { mtime: "T-stale", size: 5 };

    await reconcileExternalChange(entry);

    expect(entry.diskDiverged).toBeUndefined();
    expect(entry.lastLoadedValue).toBe("new-from-disk");
    expect(entry.model?.getValue()).toBe("new-from-disk");
  });

  test("snapshot shows no diskDiverged after clean reload", async () => {
    const deps = makeDeps();
    const entry = makeEntry("original", "original", deps);
    entry.diskDiverged = { mtime: "T-old", size: 10 };

    await reconcileExternalChange(entry);

    expect(snapshot(entry).diskDiverged).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// reloadEntryFromDisk — always replaces buffer
// ---------------------------------------------------------------------------

describe("reloadEntryFromDisk", () => {
  test("replaces dirty buffer with disk content and clears diskDiverged", async () => {
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: "disk-content-v2",
          mtime: "T-disk-v2",
          sizeBytes: 88,
          isBinary: false,
        }),
    });

    // Buffer is "dirty" (different from lastLoadedValue)
    const entry = makeEntry("user-edits-here", "base", deps);
    entry.diskDiverged = { mtime: "T-disk-v2", size: 88 };

    let notified = false;
    entry.subscribers.add(() => {
      notified = true;
    });

    await reloadEntryFromDisk(entry);

    expect(entry.model?.getValue()).toBe("disk-content-v2");
    expect(entry.lastLoadedValue).toBe("disk-content-v2");
    expect(entry.diskDiverged).toBeUndefined();
    expect(entry.phase).toBe("ready");
    expect(notified).toBe(true);
  });

  test("does nothing when entry is disposed", async () => {
    const deps = makeDeps();
    const entry = makeEntry("content", "content", deps);
    entry.disposed = true;

    // Should not throw
    await reloadEntryFromDisk(entry);
    // Model unchanged
    expect(entry.model?.getValue()).toBe("content");
  });

  test("skips model update when buffer already matches disk content", async () => {
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: "same-as-buffer",
          mtime: "T-x",
          sizeBytes: 14,
          isBinary: false,
        }),
    });

    const entry = makeEntry("same-as-buffer", "base", deps);
    entry.diskDiverged = { mtime: "T-x", size: 14 };

    await reloadEntryFromDisk(entry);

    // setValue should not be called — buffer already matches
    expect(entry.model?.getValue()).toBe("same-as-buffer");
    expect(entry.diskDiverged).toBeUndefined();
  });
});
