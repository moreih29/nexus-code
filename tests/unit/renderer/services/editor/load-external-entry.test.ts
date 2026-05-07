import { beforeEach, describe, expect, mock, test } from "bun:test";

// Provide a minimal window.ipc stub so ipc/client.ts can be imported.
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ---------------------------------------------------------------------------
// IPC mock — replaced per-test via ipcCallMock.mockImplementation
// ---------------------------------------------------------------------------

const ipcCallMock = mock(() => Promise.resolve(null as unknown));

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: ipcCallMock,
  ipcListen: () => () => {},
}));

// ---------------------------------------------------------------------------
// Monaco singleton mock
// ---------------------------------------------------------------------------

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

mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
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

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are registered)
// ---------------------------------------------------------------------------

const { loadExternalEntry } = await import(
  "../../../../../src/renderer/services/editor/load-external-entry"
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
  // Default: model not in cache, create a fresh one
  getModelMock.mockImplementation(() => null);
  createModelMock.mockImplementation((_content: string, _lang: unknown, _uri: unknown) =>
    makeModel(_content),
  );
});

// ---------------------------------------------------------------------------
// Scenario 1: success path — phase=ready, origin=external, readOnly=true
// ---------------------------------------------------------------------------

describe("loadExternalEntry — success", () => {
  test("returns ModelEntry with origin=external, readOnly=true, originatingWorkspaceId", async () => {
    ipcCallMock.mockImplementation(() => Promise.resolve(makeFileContent()));

    const entry = await loadExternalEntry(INPUT);

    expect(entry.phase).toBe("ready");
    expect(entry.origin).toBe("external");
    expect(entry.readOnly).toBe(true);
    expect(entry.originatingWorkspaceId).toBe(INPUT.workspaceId);
  });

  test("sets input workspaceId and filePath from function argument", async () => {
    ipcCallMock.mockImplementation(() => Promise.resolve(makeFileContent()));

    const entry = await loadExternalEntry(INPUT);

    expect(entry.input.workspaceId).toBe(INPUT.workspaceId);
    expect(entry.input.filePath).toBe(INPUT.filePath);
    expect(entry.input.origin).toBe("external");
    expect(entry.input.readOnly).toBe(true);
  });

  test("calls ipcCall with fs / readExternal / absolutePath", async () => {
    ipcCallMock.mockImplementation(() => Promise.resolve(makeFileContent()));

    await loadExternalEntry(INPUT);

    expect(ipcCallMock).toHaveBeenCalledTimes(1);
    const [channel, method, args] = ipcCallMock.mock.calls[0] as [
      string,
      string,
      { absolutePath: string },
    ];
    expect(channel).toBe("fs");
    expect(method).toBe("readExternal");
    expect(args.absolutePath).toBe(INPUT.filePath);
  });

  test("model is set on entry after success", async () => {
    ipcCallMock.mockImplementation(() => Promise.resolve(makeFileContent()));

    const entry = await loadExternalEntry(INPUT);

    expect(entry.model).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: IPC error → phase=error
// ---------------------------------------------------------------------------

describe("loadExternalEntry — IPC error", () => {
  test("returns entry with phase=error when ipcCall rejects", async () => {
    ipcCallMock.mockImplementation(() =>
      Promise.reject(new Error("NOT_FOUND: /external/src/lib.ts")),
    );

    const entry = await loadExternalEntry(INPUT);

    expect(entry.phase).toBe("error");
    expect(entry.errorCode).toBeDefined();
  });

  test("entry is still origin=external and readOnly=true even on error", async () => {
    ipcCallMock.mockImplementation(() =>
      Promise.reject(new Error("PERMISSION_DENIED: /external/src/lib.ts")),
    );

    const entry = await loadExternalEntry(INPUT);

    expect(entry.origin).toBe("external");
    expect(entry.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: binary response → phase=binary
// ---------------------------------------------------------------------------

describe("loadExternalEntry — binary response", () => {
  test("returns phase=binary when isBinary=true in IPC response", async () => {
    ipcCallMock.mockImplementation(() =>
      Promise.resolve(makeFileContent({ isBinary: true, content: "" })),
    );

    const entry = await loadExternalEntry(INPUT);

    expect(entry.phase).toBe("binary");
    expect(entry.model).toBeNull();
  });

  test("binary entry is still origin=external and readOnly=true", async () => {
    ipcCallMock.mockImplementation(() =>
      Promise.resolve(makeFileContent({ isBinary: true, content: "" })),
    );

    const entry = await loadExternalEntry(INPUT);

    expect(entry.origin).toBe("external");
    expect(entry.readOnly).toBe(true);
  });
});
