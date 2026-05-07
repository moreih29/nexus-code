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
// We mock ONLY the modules whose behavior the read-only/no-op branches of
// saveModel actually depend on. Both tests below short-circuit before save-
// service touches promote-policy / lsp-bridge / file-loader / save-sequentializer,
// so those are intentionally NOT mocked.
//
// For the modules we do mock (dirty-tracker, model-cache, ipc/client, toast),
// we spread the real exports first so other test files (e.g., promote-policy
// .test.ts) can still import their full surface.
const realDirty = await import("../../../../../src/renderer/services/editor/dirty-tracker");
const realModelCache = await import("../../../../../src/renderer/services/editor/model-cache");

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
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

mock.module("../../../../../src/renderer/services/editor/dirty-tracker", () => ({
  ...realDirty,
  getDirtyEntry: getDirtyEntryMock,
}));

const getResolvedModelMock = mock((_input: unknown) => null as unknown);

mock.module("../../../../../src/renderer/services/editor/model-cache", () => ({
  ...realModelCache,
  getResolvedModel: getResolvedModelMock,
}));

const { saveModel } = await import("../../../../../src/renderer/services/editor/save-service");

const INPUT = { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" };

function makeModel(value = "content") {
  return {
    getValue: () => value,
    getAlternativeVersionId: () => 2,
  };
}

afterEach(() => {
  showToastMock.mockClear();
  getDirtyEntryMock.mockClear();
  getResolvedModelMock.mockClear();
});

describe("saveModel read-only guard", () => {
  test("returns read-only and shows toast when entry is read-only", async () => {
    getResolvedModelMock.mockImplementation(() => ({
      model: makeModel(),
      cacheUri: "file:///workspace/src/a.ts",
      workspaceId: "ws-1",
      filePath: "/workspace/src/a.ts",
      languageId: "typescript",
      readOnly: true,
    }));

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
    getResolvedModelMock.mockImplementation(() => ({
      model: makeModel(),
      cacheUri: "file:///workspace/src/a.ts",
      workspaceId: "ws-1",
      filePath: "/workspace/src/a.ts",
      languageId: "typescript",
      readOnly: false,
    }));
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
