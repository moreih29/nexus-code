import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TextEncoding } from "../../../../../src/renderer/services/editor/encoding/text-encoding";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const realDirty = await import("../../../../../src/renderer/services/editor/model/dirty-tracker");
const realModelCache = await import("../../../../../src/renderer/services/editor/model/cache");
const realFileLoader = await import(
  "../../../../../src/renderer/services/editor/model/file-loader"
);

const ipcCallMock = mock((_service: unknown, _method: unknown, _args: unknown) =>
  Promise.resolve({ ok: true as const, value: { mtime: "T1", size: 42 } }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: ipcCallMock,
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
const reloadModelFromDiskMock = mock((_input: unknown) => Promise.resolve(true));
const clearDiskDivergedMock = mock((_input: unknown) => {});
const syncLoadedValueAfterSaveMock = mock((_input: unknown, _content: string) => {});

mock.module("../../../../../src/renderer/services/editor/model/cache", () => ({
  ...realModelCache,
  getResolvedModel: getResolvedModelMock,
  reloadModelFromDisk: reloadModelFromDiskMock,
  clearDiskDiverged: clearDiskDivergedMock,
  syncLoadedValueAfterSave: syncLoadedValueAfterSaveMock,
}));

mock.module("../../../../../src/renderer/services/editor/model/file-loader", () => ({
  ...realFileLoader,
  relPathForInput: mock((_input: unknown) => "src/a.ts"),
}));

const showConflictResolutionMock = mock((_filename: string) =>
  Promise.resolve("cancel" as "overwrite" | "reload" | "cancel"),
);

mock.module("../../../../../src/renderer/components/editor/conflict-dialog", () => ({
  showConflictResolution: showConflictResolutionMock,
  ConflictResolutionDialogRoot: () => null,
  __resetConflictDialogForTests: () => {},
}));

const { saveModel, saveModelInteractive } = await import(
  "../../../../../src/renderer/services/editor/save/service"
);

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
    encoding: "utf8" as TextEncoding,
    ...overrides,
  };
}

afterEach(() => {
  showToastMock.mockClear();
  getDirtyEntryMock.mockClear();
  getResolvedModelMock.mockClear();
  ipcCallMock.mockClear();
  markSavedMock.mockClear();
  reloadModelFromDiskMock.mockClear();
  clearDiskDivergedMock.mockClear();
  syncLoadedValueAfterSaveMock.mockClear();
  showConflictResolutionMock.mockClear();
  getDirtyEntryMock.mockImplementation(() => ({
    isDirty: true,
    loadedMtime: "T0",
    loadedSize: 10,
  }));
  getResolvedModelMock.mockImplementation(() => null);
  ipcCallMock.mockImplementation(() =>
    Promise.resolve({ ok: true as const, value: { mtime: "T1", size: 42 } }),
  );
  showConflictResolutionMock.mockImplementation(() => Promise.resolve("cancel"));
});

describe("saveModel read-only guard", () => {
  test("returns read-only and shows toast when entry is read-only", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel({ readOnly: true }));

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("read-only");
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect((showToastMock.mock.calls[0] as [{ kind: string; message: string }])[0]).toEqual({
      kind: "info",
      message: "File is read-only.",
    });
    expect(getDirtyEntryMock).not.toHaveBeenCalled();
  });
});

describe("saveModel conflict", () => {
  test("returns conflict when ipcCallResult reports a disk mtime mismatch", async () => {
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: true,
      loadedMtime: "T0",
      loadedSize: 10,
    }));
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          kind: "conflict",
          actual: { exists: true, mtime: "T2", size: 99 },
        },
      }),
    );

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.actual).toEqual({ exists: true, mtime: "T2", size: 99 });
    }
    expect(markSavedMock).not.toHaveBeenCalled();
  });
});

describe("saveModel baseline sync", () => {
  test("advances lastLoadedValue to the written content on a successful save", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: true,
      loadedMtime: "T0",
      loadedSize: 10,
    }));

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("saved");
    expect(syncLoadedValueAfterSaveMock).toHaveBeenCalledWith(INPUT, "content");
  });

  test("writes the BOM back for a file read as utf8-bom, but keeps it out of the baseline", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel({ encoding: "utf8-bom" }));

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("saved");
    const write = ipcCallMock.mock.calls.find(([, method]) => method === "writeFile");
    expect((write?.[2] as { content: string }).content).toBe("﻿content");
    expect(syncLoadedValueAfterSaveMock).toHaveBeenCalledWith(INPUT, "content");
  });

  test("writes no BOM for a plain utf8 file", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel({ encoding: "utf8" }));

    await saveModel(INPUT);

    const write = ipcCallMock.mock.calls.find(([, method]) => method === "writeFile");
    expect((write?.[2] as { content: string }).content).toBe("content");
  });

  test("writes a file in another encoding as its bytes", async () => {
    getResolvedModelMock.mockImplementation(() =>
      makeResolvedModel({ model: makeModel("한글"), encoding: "euc-kr" }),
    );

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("saved");
    const write = ipcCallMock.mock.calls.find(([, method]) => method === "writeFile");
    expect(write?.[2]).toMatchObject({ content: "", bytes: "x9Gx2w==" });
    expect(syncLoadedValueAfterSaveMock).toHaveBeenCalledWith(INPUT, "한글");
  });

  test("does not write a character the file's encoding has no bytes for", async () => {
    getResolvedModelMock.mockImplementation(() =>
      makeResolvedModel({ model: makeModel("ok\n😀"), encoding: "euc-kr" }),
    );

    const result = await saveModel(INPUT);

    expect(result).toEqual({
      kind: "error",
      message: 'EUC-KR (CP949) has no character "😀" (line 2, column 1)',
    });
    expect(ipcCallMock.mock.calls.some(([, method]) => method === "writeFile")).toBe(false);
  });

  test("Save with Encoding writes the file in it even with no edits", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel({ model: makeModel("hi") }));
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: false,
      loadedMtime: "T0",
      loadedSize: 10,
    }));

    expect((await saveModel(INPUT)).kind).toBe("not-dirty");
    const result = await saveModel(INPUT, { encoding: "utf-16le" });

    expect(result.kind).toBe("saved");
    const write = ipcCallMock.mock.calls.find(([, method]) => method === "writeFile");
    expect(write?.[2]).toMatchObject({ content: "", bytes: "//5oAGkA" });
  });

  test("does not advance the baseline when the save conflicts", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        value: { kind: "conflict", actual: { exists: true, mtime: "T2", size: 99 } },
      }),
    );

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("conflict");
    expect(syncLoadedValueAfterSaveMock).not.toHaveBeenCalled();
  });
});

describe("saveModel superseded", () => {
  test("middle call returns superseded when displaced by a third concurrent call", async () => {
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
        return firstIpcHeld.then(() => ({ ok: true as const, value: { mtime: "T1", size: 10 } }));
      }
      return Promise.resolve({ ok: true as const, value: { mtime: "T2", size: 20 } });
    });

    const p1 = saveModel(INPUT);
    await Promise.resolve();

    const p2 = saveModel(INPUT);
    const p3 = saveModel(INPUT);

    const r2 = await p2;
    expect(r2.kind).toBe("superseded");

    resolveFirstIpc(undefined);
    const [r1, r3] = await Promise.all([p1, p3]);
    expect(r1.kind).toBe("saved");
    expect(r3.kind).toBe("saved");
  });
});

describe("saveModel race — dirty=false re-check inside gate", () => {
  test("returns not-dirty when undo clears dirty state before the gate executes", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    let callIndex = 0;
    getDirtyEntryMock.mockImplementation(() => {
      callIndex += 1;
      return {
        isDirty: callIndex === 1,
        loadedMtime: "T0",
        loadedSize: 10,
      };
    });

    const result = await saveModel(INPUT);

    expect(result.kind).toBe("not-dirty");
    expect(getDirtyEntryMock).toHaveBeenCalledTimes(2);
    expect(ipcCallMock).not.toHaveBeenCalled();
    expect(markSavedMock).not.toHaveBeenCalled();
  });
});

describe("saveModelInteractive — no conflict", () => {
  test("returns saved result directly without showing dialog", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({ ok: true as const, value: { mtime: "T1", size: 42 } }),
    );

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("saved");
    expect(showConflictResolutionMock).not.toHaveBeenCalled();
  });

  test("does not show dialog when saveModel returns not-dirty", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    getDirtyEntryMock.mockImplementation(() => ({
      isDirty: false,
      loadedMtime: "T0",
      loadedSize: 10,
    }));

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("not-dirty");
    expect(showConflictResolutionMock).not.toHaveBeenCalled();
  });
});

describe("saveModelInteractive — conflict, user cancels", () => {
  test("returns original conflict result and shows no retry when user cancels", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          kind: "conflict",
          actual: { exists: true, mtime: "T2", size: 99 },
        },
      }),
    );
    showConflictResolutionMock.mockImplementation(() => Promise.resolve("cancel"));

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("conflict");
    expect(reloadModelFromDiskMock).not.toHaveBeenCalled();
    expect(ipcCallMock).toHaveBeenCalledTimes(1);
  });
});

describe("saveModelInteractive — conflict, user chooses reload", () => {
  test("reloads model from disk and returns not-dirty", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          kind: "conflict",
          actual: { exists: true, mtime: "T2", size: 99 },
        },
      }),
    );
    showConflictResolutionMock.mockImplementation(() => Promise.resolve("reload"));

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("not-dirty");
    expect(reloadModelFromDiskMock).toHaveBeenCalledWith(INPUT, undefined, expect.any(Function));
    expect(ipcCallMock).toHaveBeenCalledTimes(1);
  });

  test("reports a skipped conflict reload as superseded so close keeps the buffer open", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          kind: "conflict",
          actual: { exists: true, mtime: "T2", size: 99 },
        },
      }),
    );
    showConflictResolutionMock.mockImplementation(() => Promise.resolve("reload"));
    reloadModelFromDiskMock.mockImplementationOnce(async () => false);

    expect((await saveModelInteractive(INPUT)).kind).toBe("superseded");
  });
});

describe("saveModelInteractive — conflict, user chooses overwrite", () => {
  test("retries save and returns saved when disk file exists", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    let ipcCallCount = 0;
    ipcCallMock.mockImplementation(() => {
      ipcCallCount += 1;
      if (ipcCallCount === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            kind: "conflict",
            actual: { exists: true, mtime: "T2", size: 99 },
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: { mtime: "T3", size: 42 } });
    });

    showConflictResolutionMock.mockImplementation(() => Promise.resolve("overwrite"));

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("saved");
    expect(showConflictResolutionMock).toHaveBeenCalledTimes(1);
    expect(clearDiskDivergedMock).toHaveBeenCalledWith(INPUT);
    expect(ipcCallMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("retries save and returns saved when disk file was deleted (exists:false)", async () => {
    getResolvedModelMock.mockImplementation(() => makeResolvedModel());

    let ipcCallCount = 0;
    ipcCallMock.mockImplementation(() => {
      ipcCallCount += 1;
      if (ipcCallCount === 1) {
        return Promise.resolve({
          ok: true as const,
          value: {
            kind: "conflict",
            actual: { exists: false },
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: { mtime: "T-new", size: 30 } });
    });

    showConflictResolutionMock.mockImplementation(() => Promise.resolve("overwrite"));

    const result = await saveModelInteractive(INPUT);

    expect(result.kind).toBe("saved");
    expect(clearDiskDivergedMock).toHaveBeenCalledWith(INPUT);
  });
});
