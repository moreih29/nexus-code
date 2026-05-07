/**
 * Unit tests for forceDisposeExternalsForWorkspace.
 *
 * Verifies that closing workspace A disposes only that workspace's external
 * models, leaving workspace B's external models and workspace A's own
 * workspace-origin models untouched.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Bun mock.module is process-global. Spread real exports so other editor/*
// test files see the full module surface after this file runs.
const realLspBridge = await import("../../../../../src/renderer/services/editor/lsp-bridge");

mock.module("../../../../../src/renderer/services/editor/lsp-bridge", () => ({
  ...realLspBridge,
  ensureProvidersFor: () => {},
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  notifyDidSave: () => Promise.resolve(),
}));

const realMonacoSingleton = await import(
  "../../../../../src/renderer/services/editor/monaco-singleton"
);

mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
  ...realMonacoSingleton,
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => ({
    Uri: { parse: (raw: string) => ({ toString: () => raw }) },
    editor: {
      getModel: () => null,
      createModel: (content: string, _lang: unknown, _uri: unknown) => ({
        getValue: () => content,
        setValue: () => {},
        getLanguageId: () => "typescript",
        isDisposed: () => false,
        dispose: () => {},
      }),
    },
  }),
}));

// Provide a minimal window.ipc stub so ipc/client.ts can be imported.
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

const ipcCallMock = mock((_ch: unknown, _method: unknown, _args: unknown) =>
  Promise.resolve({
    content: "# stub\n",
    encoding: "utf8",
    sizeBytes: 8,
    isBinary: false,
    mtime: new Date().toISOString(),
  }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: ipcCallMock,
  ipcListen: () => () => {},
}));

const cleanupEntryMock = mock((_entry: unknown) => {});

const realModelEntry = await import("../../../../../src/renderer/services/editor/model-entry");

mock.module("../../../../../src/renderer/services/editor/model-entry", () => ({
  ...realModelEntry,
  cleanupEntry: cleanupEntryMock,
  createEntry: (input: { workspaceId: string; filePath: string }, cacheUri: string) => ({
    input,
    cacheUri,
    lspUri: cacheUri,
    languageId: "typescript",
    refCount: 0,
    phase: "ready" as const,
    model: null,
    loadPromise: Promise.resolve(),
    subscribers: new Set<() => void>(),
    origin: (input as { origin?: string }).origin ?? "workspace",
    readOnly: (input as { readOnly?: boolean }).readOnly ?? false,
    disposed: false,
    originatingWorkspaceId:
      (input as { origin?: string }).origin === "external" ? input.workspaceId : undefined,
  }),
}));

const { acquireModel, forceDisposeExternalsForWorkspace, getModelSnapshot, releaseModel } =
  await import("../../../../../src/renderer/services/editor/model-cache");

const WS_A = "ws-aaa";
const WS_B = "ws-bbb";

function extInputA(filePath: string) {
  return { workspaceId: WS_A, filePath, origin: "external" as const, readOnly: true };
}
function extInputB(filePath: string) {
  return { workspaceId: WS_B, filePath, origin: "external" as const, readOnly: true };
}
function wsInputA(filePath: string) {
  return { workspaceId: WS_A, filePath };
}

beforeEach(() => {
  cleanupEntryMock.mockClear();
  ipcCallMock.mockClear();
});

describe("forceDisposeExternalsForWorkspace", () => {
  test("disposes external entries for the closed workspace", async () => {
    const a1 = extInputA("/ext/wsc-cleanup-a1.py");
    const a2 = extInputA("/ext/wsc-cleanup-a2.py");

    await acquireModel(a1);
    await acquireModel(a2);

    forceDisposeExternalsForWorkspace(WS_A);

    expect(getModelSnapshot(a1)).toBeNull();
    expect(getModelSnapshot(a2)).toBeNull();
    expect(cleanupEntryMock).toHaveBeenCalledTimes(2);
  });

  test("leaves external entries from other workspaces intact", async () => {
    const b1 = extInputB("/ext/wsc-cleanup-b1.ts");

    await acquireModel(b1);

    forceDisposeExternalsForWorkspace(WS_A);

    expect(getModelSnapshot(b1)).not.toBeNull();
    expect(cleanupEntryMock).not.toHaveBeenCalled();
    releaseModel(b1);
  });

  test("leaves workspace-origin entries from the same workspace untouched", async () => {
    const ws1 = wsInputA("/wsc-cleanup-ws1/src/index.ts");

    await acquireModel(ws1);

    forceDisposeExternalsForWorkspace(WS_A);

    expect(getModelSnapshot(ws1)).not.toBeNull();
    expect(cleanupEntryMock).not.toHaveBeenCalled();
    releaseModel(ws1);
  });

  test("only disposes workspace A's externals when both A and B have them", async () => {
    const a1 = extInputA("/ext/wsc-mixed-a.py");
    const b1 = extInputB("/ext/wsc-mixed-b.py");
    const ws1 = wsInputA("/wsc-mixed-ws1/src/comp.ts");

    await acquireModel(a1);
    await acquireModel(b1);
    await acquireModel(ws1);

    forceDisposeExternalsForWorkspace(WS_A);

    expect(getModelSnapshot(a1)).toBeNull();
    expect(getModelSnapshot(b1)).not.toBeNull();
    expect(getModelSnapshot(ws1)).not.toBeNull();
    expect(cleanupEntryMock).toHaveBeenCalledTimes(1);

    releaseModel(b1);
    releaseModel(ws1);
  });

  test("is a no-op when no external entries exist for the workspace", () => {
    forceDisposeExternalsForWorkspace("ws-nonexistent");
    expect(cleanupEntryMock).not.toHaveBeenCalled();
  });
});
