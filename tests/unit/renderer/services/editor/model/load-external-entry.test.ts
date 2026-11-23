import { beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const ipcCallMock = mock(() => Promise.resolve({ ok: true as const, value: null as unknown }));

mock.module("../../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: ipcCallMock,
  ipcListen: () => () => {},
  canUseIpcBridge: () => false,
  unwrapIpcResult: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    const err = new Error(result.message ?? "ipc error");
    err.name = `IpcError[${result.kind ?? "unknown"}]`;
    throw err;
  },
  mustSucceed: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    const err = new Error(result.message ?? "ipc error");
    err.name = `IpcError[${result.kind ?? "unknown"}]`;
    throw err;
  },
  unwrapGitResult: <T>(result: { ok: boolean; value?: T; message?: string; kind?: string }): T => {
    if (result.ok) return result.value as T;
    throw new Error(result.message ?? "git ipc error");
  },
  isIpcResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && "ok" in (v as object),
  isIpcOkResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === true,
  isIpcErrResult: (v: unknown): boolean =>
    v !== null && typeof v === "object" && (v as Record<string, unknown>)["ok"] === false,
  ipcStream: () => ({ promise: Promise.resolve(undefined), onProgress: () => () => {} }),
}));

function makeModel(content = "") {
  let stored = content;
  return {
    getValue: () => stored,
    setValue: (v: string) => {
      stored = v;
    },
    getLanguageId: () => "typescript",
  };
}

const getModelMock = mock((_uri: unknown) => null);
const createModelMock = mock((_content: string, _lang: unknown, _uri: unknown) =>
  makeModel(_content),
);

mock.module("../../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  requireMonaco: () => ({
    Uri: {
      parse: (raw: string) => ({ toString: () => raw, _raw: raw }),
    },
    editor: {
      getModel: getModelMock,
      createModel: createModelMock,
    },
  }),
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
}));

const { loadExternalEntry } = await import(
  "../../../../../../src/renderer/services/editor/model/load-external-entry"
);

const INPUT = { workspaceId: "ws-abc", filePath: "/external/src/lib.ts" };

function makeFileContent(
  overrides: Partial<{
    content: string;
    encoding: "utf8" | "utf8-bom";
    sizeBytes: number;
    isBinary: boolean;
    mtime: string;
  }> = {},
) {
  return {
    kind: "ok" as const,
    content: "export const x = 1;\n",
    encoding: "utf8" as const,
    sizeBytes: 20,
    isBinary: false,
    mtime: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  ipcCallMock.mockClear();
  getModelMock.mockClear();
  createModelMock.mockClear();
  getModelMock.mockImplementation(() => null);
  createModelMock.mockImplementation((_content: string, _lang: unknown, _uri: unknown) =>
    makeModel(_content),
  );
});

describe("loadExternalEntry — success", () => {
  test("returns a ready ModelEntry with origin=external, readOnly=true, originatingWorkspaceId", async () => {
    ipcCallMock.mockImplementation(() =>
      Promise.resolve({ ok: true as const, value: makeFileContent() }),
    );

    const entry = await loadExternalEntry(INPUT);

    expect(entry.phase).toBe("ready");
    expect(entry.model).not.toBeNull();
    expect(entry.origin).toBe("external");
    expect(entry.readOnly).toBe(true);
    expect(entry.originatingWorkspaceId).toBe(INPUT.workspaceId);
  });
});
