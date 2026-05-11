import { afterEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// IMPORTANT: Bun's `mock.module` is PROCESS-GLOBAL — replacing a module here
// affects every other test file that imports it later in the same process.
// We mock ONLY the modules whose behavior saveModel branches actually depend on
// and spread real exports so other test files see the full module surface.
//
// promote-policy and lsp-bridge are NOT mocked:
//   - promoteAllPreviewTabsForFile reads useTabsStore which initialises to
//     { byWorkspace: {} } — calling it is a no-op when no tabs are registered.
//   - notifyDidSave calls ipcCall, which IS mocked below.
// file-loader IS mocked: relPathForInput calls useWorkspacesStore which throws
// WORKSPACE_NOT_FOUND when no workspaces are seeded.
const realDirty = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");
const realModelCache = await import(
  "../../../../../src/renderer/services/editor/model/model-cache"
);
const realFileLoader = await import(
  "../../../../../src/renderer/services/editor/model/file-loader"
);

const ipcCallMock = mock((_service: unknown, _method: unknown, _args: unknown) =>
  Promise.resolve({ mtime: "T1", size: 42 }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: ipcCallMock,
  ipcListen: () => () => {},
}));

const showToastMock = mock((_input: unknown) => {});

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: showToastMock,
}));

const getDirtyEntryMock = mock((_cacheUri: string) => ({
  isDirty: true,
  loadedMtime: "T0",
  loadedSize: 10,
}));

const markSavedMock = mock((_opts: unknown) => {});

mock.module("../../../../../src/renderer/services/editor/model/dirty-tracker", () => ({
  ...realDirty,
  getDirtyEntry: getDirtyEntryMock,
  markSaved: markSavedMock,
}));

const getResolvedModelMock = mock((_input: unknown) => null as unknown);

mock.module("../../../../../src/renderer/services/editor/model/model-cache", () => ({
  ...realModelCache,
  getResolvedModel: getResolvedModelMock,
}));

mock.module("../../../../../src/renderer/services/editor/model/file-loader", () => ({
  ...realFileLoader,
  relPathForInput: mock((_input: unknown) => "src/a.ts"),
}));

const { saveModel } = await import("../../../../../src/renderer/services/editor/save/save-service");

const INPUT = { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" };
const CACHE_URI = "file:///workspace/src/a.ts";

function makeModel(value = "content") {
  return {
    getValue: () => value,
    getAlternativeVersionId: () => 2,
  };
}

function makeResolvedModel(overrides: Partial<ReturnType<typeof makeResolvedModel>> = {}) {
  return {
    model: makeModel(),
    cacheUri: CACHE_URI,
    workspaceId: "ws-1",
    filePath: "/workspace/src/a.ts",
    languageId: "typescript",
    readOnly: false,
    ...overrides,
  };
}

afterEach(() => {
  showToastMock.mockClear();
  getDirtyEntryMock.mockClear();
  getResolvedModelMock.mockClear();
  ipcCallMock.mockClear();
  markSavedMock.mockClear();
});

describe("saveModel read-only guard", () => {
  test("returns read-only and shows toast when entry is read-only", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel({ readOnly: true }));

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("read-only");
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect((showToastMock.mock.calls[0] as [{ kind: string; message: string }])[0]).toEqual({
      kind: "info",
      message: "File is read-only",
    });
    // Dirty tracker must NOT be queried — guard fires before dirty check.
    expect(getDirtyEntryMock).not.toHaveBeenCalled();
  });

  test("does not call showToast and proceeds normally when entry is writable", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: false,
      loadedMtime: "T0",
      loadedSize: 10,
    }));

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("not-dirty");
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

describe("saveModel conflict", () => {
  test("returns conflict when ipcCall reports a disk mtime mismatch", async () => {
    // Outer dirty check: isDirty=true so the gate is entered.
    // Inner dirty re-check: also isDirty=true so the IPC write is attempted.
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: true,
      loadedMtime: "T0",
      loadedSize: 10,
    }));
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    // Simulate main-process detecting that the on-disk mtime differs from
    // the renderer's baseline snapshot — another process modified the file.
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        kind: "conflict",
        actual: { exists: true, mtime: "T2", size: 99 },
      }),
    );

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.actual).toEqual({ exists: true, mtime: "T2", size: 99 });
    }
    // markSaved must NOT be called — dirty baseline must stay unchanged so
    // the caller can decide to reload or force-save.
    expect(markSavedMock).not.toHaveBeenCalled();
  });
});

describe("saveModel superseded", () => {
  test("middle call returns superseded when displaced by a third concurrent call", async () => {
    // Three concurrent saveModel calls on the same file:
    //   p1 — starts running; its ipcCall is held open by a deferred promise.
    //   p2 — queues behind p1.
    //   p3 — displaces p2 in the queue, causing p2's sequentializer promise
    //         to reject with SaveSupersededError → saveModel returns "superseded".
    //   p1 and p3 both complete normally (saved).
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: true,
      loadedMtime: "T0",
      loadedSize: 10,
    }));

    let resolveFirstIpc!: (value: unknown) => void;
    const firstIpcHeld = new Promise((res) => {
      resolveFirstIpc = res;
    });

    let callCount = 0;
    ipcCallMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        // First call: hold open so the gate stays occupied.
        return firstIpcHeld.then(() => ({ mtime: "T1", size: 10 }));
      }
      // Third call (p3's fn): resolves immediately.
      return Promise.resolve({ mtime: "T2", size: 20 });
    });

    const p1 = saveModel(INPUT);
    // Yield so p1's fn starts executing inside the gate before p2 queues.
    await Promise.resolve();

    const p2 = saveModel(INPUT);
    // p3 arrives immediately after p2 — displaces p2 from the queue.
    const p3 = saveModel(INPUT);

    // p2 should be superseded before the ipc even settles.
    const r2 = await p2;
    expect(r2.kind).toBe("superseded");

    // Release p1's ipcCall so both p1 and p3 can finish.
    resolveFirstIpc(undefined);
    const [r1, r3] = await Promise.all([p1, p3]);
    expect(r1.kind).toBe("saved");
    expect(r3.kind).toBe("saved");
  });
});

describe("saveModel race — dirty=false re-check inside gate", () => {
  test("returns not-dirty when undo clears dirty state before the gate executes", async () => {
    // The outer getDirtyEntry call (before the gate) sees isDirty=true,
    // so execution enters sequentializer.run(). Inside the gate the entry
    // is re-read (save-service.ts line ~67) and isDirty is now false — the
    // user undid all changes while the gate was being entered. The function
    // must short-circuit with "not-dirty" without touching ipcCall or markSaved.
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    let callIndex = 0;
    getDirtyEntryMock.mockImplementation(() => {
      callIndex += 1;
      // First call: outer pre-gate check — dirty=true so we enter the gate.
      // Second call: inner re-check inside the gate — undo has fired, dirty=false.
      return {
        isDirty: callIndex === 1,
        loadedMtime: "T0",
        loadedSize: 10,
      };
    });

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("not-dirty");
    // getDirtyEntry must have been called twice: outer check + inner re-check.
    expect(getDirtyEntryMock).toHaveBeenCalledTimes(2);
    // No disk write attempted.
    expect(ipcCallMock).not.toHaveBeenCalled();
    // No baseline update.
    expect(markSavedMock).not.toHaveBeenCalled();
  });
});
