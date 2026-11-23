import { describe, expect, mock, test } from "bun:test";
import type {
  ModelEntry,
  ModelEntryDeps,
} from "../../../../../../src/renderer/services/editor/model/entry";
import {
  reconcileExternalChange,
  reloadEntryFromDisk,
} from "../../../../../../src/renderer/services/editor/model/entry";
import type { FileLoadResult } from "../../../../../../src/renderer/services/editor/model/file-loader";

function makeModel(value: string) {
  let content = value;
  let version = 1;
  return {
    getValue: () => content,
    setValue: (next: string) => {
      content = next;
      version += 1;
    },
    isDisposed: () => false,
    getAlternativeVersionId: () => 1,
    getVersionId: () => version,
  };
}

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
    getDirtyEntry: () => undefined,
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

function makeEntry(modelValue: string, lastLoadedValue: string, deps: ModelEntryDeps): ModelEntry {
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

    const entry = makeEntry("edited-by-user", "original-from-disk", deps);

    let notified = false;
    entry.subscribers.add(() => {
      notified = true;
    });

    await reconcileExternalChange(entry);

    expect(entry.diskDiverged).toEqual({ mtime: "T-new", size: 99 });
    expect(notified).toBe(true);
    expect(entry.model?.getValue()).toBe("edited-by-user");
    expect(entry.lastLoadedValue).toBe("original-from-disk");
  });
});

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

    const entry = makeEntry("same-content", "same-content", deps);
    entry.diskDiverged = { mtime: "T-stale", size: 5 };

    await reconcileExternalChange(entry);

    expect(entry.diskDiverged).toBeUndefined();
    expect(entry.lastLoadedValue).toBe("new-from-disk");
    expect(entry.model?.getValue()).toBe("new-from-disk");
  });
});

describe("reloadEntryFromDisk", () => {
  test("keeps edits made while reopening with another encoding", async () => {
    const read = Promise.withResolvers<FileLoadResult>();
    const markDirtyTrackerSaved = mock(() => {});
    const entry = makeEntry(
      "base",
      "base",
      makeDeps({
        readFileForModel: () => read.promise,
        markDirtyTrackerSaved,
      }),
    );
    entry.encoding = "utf8";

    const reload = reloadEntryFromDisk(entry, "shift_jis");
    entry.model?.setValue("typed while waiting");
    read.resolve({
      content: "disk",
      mtime: "T2",
      sizeBytes: 4,
      isBinary: false,
      encoding: "shift_jis",
    });
    await reload;

    expect(entry.model?.getValue()).toBe("typed while waiting");
    expect(entry.encoding).toBe("utf8");
    expect(entry.lastLoadedValue).toBe("base");
    expect(markDirtyTrackerSaved).not.toHaveBeenCalled();
  });

  test("preserves edits made after approving a discard even when the read fails", async () => {
    const read = Promise.withResolvers<FileLoadResult>();
    const entry = makeEntry(
      "discard approved",
      "base",
      makeDeps({
        readFileForModel: () => read.promise,
      }),
    );
    const reload = reloadEntryFromDisk(entry);
    entry.model?.setValue("edit after approval");
    read.reject(new Error("NOT_FOUND: file deleted"));
    await reload;

    expect(entry.phase).toBe("ready");
    expect(entry.model?.getValue()).toBe("edit after approval");
    expect(entry.lastLoadedValue).toBe("base");
  });

  test("keeps the newer manual reload when an older read completes last without changing the model version", async () => {
    const first = Promise.withResolvers<FileLoadResult>();
    const second = Promise.withResolvers<FileLoadResult>();
    const reads = [first.promise, second.promise];
    const markDirtyTrackerSaved = mock(() => {});
    const entry = makeEntry(
      "same",
      "same",
      makeDeps({
        readFileForModel: () => reads.shift()!,
        markDirtyTrackerSaved,
      }),
    );

    const earlier = reloadEntryFromDisk(entry);
    const later = reloadEntryFromDisk(entry);
    second.resolve({
      content: "same",
      mtime: "T2",
      sizeBytes: 4,
      isBinary: false,
      encoding: "utf8",
    });
    await later;
    first.resolve({
      content: "old disk",
      mtime: "T1",
      sizeBytes: 8,
      isBinary: false,
      encoding: "utf8",
    });
    await earlier;

    expect(entry.model?.getValue()).toBe("same");
    expect(markDirtyTrackerSaved).toHaveBeenCalledTimes(1);
  });

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

    await reloadEntryFromDisk(entry);
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

    expect(entry.model?.getValue()).toBe("same-as-buffer");
    expect(entry.diskDiverged).toBeUndefined();
  });
});

describe("reconcileExternalChange — mixed line endings", () => {
  test("takes a later change on disk once a file with mixed line endings is loaded", async () => {
    const reads = ["a\r\nb\nc\r\n", "a\r\nb\nc\r\nd\n"];
    const deps = makeDeps({
      readFileForModel: () =>
        Promise.resolve({
          content: reads.shift() ?? "",
          mtime: "T",
          sizeBytes: 1,
          isBinary: false,
        }),
    });
    let text = "";
    const model = {
      getValue: () => text,
      setValue: (next: string) => {
        text = next.replace(/\r\n|\r/g, "\n");
      },
      isDisposed: () => false,
      getAlternativeVersionId: () => 1,
    };
    const entry = makeEntry("", "", deps);
    entry.model = model as never;

    await reconcileExternalChange(entry);
    expect(entry.lastLoadedValue).toBe("a\nb\nc\n");

    await reconcileExternalChange(entry);
    expect(entry.diskDiverged).toBeUndefined();
    expect(model.getValue()).toBe("a\nb\nc\nd\n");
  });
});
