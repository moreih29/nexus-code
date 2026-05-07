/**
 * Unit tests for acquireModel branching on input.origin.
 *
 * When origin="external", acquireModel must call loadExternalEntry.
 * When origin is absent or "workspace", acquireModel must call createEntry.
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

mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => ({
    Uri: { parse: (raw: string) => ({ toString: () => raw }) },
    editor: {
      getModel: () => null,
      createModel: (_content: string, _lang: unknown, _uri: unknown) => ({
        getValue: () => _content,
        setValue: () => {},
        getLanguageId: () => "typescript",
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

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCall: mock(() => Promise.resolve()),
  ipcListen: () => () => {},
}));

const createEntryMock = mock(
  (input: { workspaceId: string; filePath: string }, cacheUri: string) => ({
    input,
    cacheUri,
    lspUri: cacheUri,
    languageId: "typescript",
    refCount: 0,
    phase: "ready" as const,
    model: { id: cacheUri },
    loadPromise: Promise.resolve(),
    subscribers: new Set<() => void>(),
    origin: "workspace" as const,
    readOnly: false,
    disposed: false,
    originatingWorkspaceId: undefined,
  }),
);

const realModelEntry = await import("../../../../../src/renderer/services/editor/model-entry");

mock.module("../../../../../src/renderer/services/editor/model-entry", () => ({
  ...realModelEntry,
  createEntry: createEntryMock,
  cleanupEntry: mock(() => {}),
  snapshot: (entry: { phase: string; model: unknown; readOnly?: boolean }) => ({
    phase: entry.phase,
    model: entry.model,
    readOnly: entry.readOnly ?? false,
  }),
}));

const realLoadExternalEntry = await import(
  "../../../../../src/renderer/services/editor/load-external-entry"
);

const loadExternalEntryMock = mock(async (input: { workspaceId: string; filePath: string }) => ({
  input: { ...input, origin: "external" as const, readOnly: true },
  cacheUri: `file://${input.filePath}`,
  lspUri: `file://${input.filePath}`,
  languageId: "python",
  refCount: 1,
  phase: "ready" as const,
  model: { id: `file://${input.filePath}` },
  loadPromise: Promise.resolve(),
  subscribers: new Set<() => void>(),
  origin: "external" as const,
  readOnly: true,
  disposed: false,
  originatingWorkspaceId: input.workspaceId,
}));

mock.module("../../../../../src/renderer/services/editor/load-external-entry", () => ({
  ...realLoadExternalEntry,
  loadExternalEntry: loadExternalEntryMock,
}));

const { acquireModel, releaseModel } = await import(
  "../../../../../src/renderer/services/editor/model-cache"
);

const WS_INPUT = { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" };
const EXT_INPUT = {
  workspaceId: "ws-1",
  filePath: "/external/lib/util.py",
  origin: "external" as const,
  readOnly: true,
};

beforeEach(() => {
  createEntryMock.mockClear();
  loadExternalEntryMock.mockClear();
  // Release any cached entries to keep tests independent.
  releaseModel(WS_INPUT);
  releaseModel(EXT_INPUT);
});

describe("acquireModel — origin branching", () => {
  test("calls createEntry for workspace origin (no origin field)", async () => {
    await acquireModel(WS_INPUT);
    expect(createEntryMock).toHaveBeenCalledTimes(1);
    expect(loadExternalEntryMock).not.toHaveBeenCalled();
    releaseModel(WS_INPUT);
  });

  test("calls createEntry for explicit origin=workspace", async () => {
    const input = { ...WS_INPUT, origin: "workspace" as const };
    await acquireModel(input);
    expect(createEntryMock).toHaveBeenCalledTimes(1);
    expect(loadExternalEntryMock).not.toHaveBeenCalled();
    releaseModel(input);
  });

  test("calls loadExternalEntry for origin=external", async () => {
    await acquireModel(EXT_INPUT);
    expect(loadExternalEntryMock).toHaveBeenCalledTimes(1);
    expect(loadExternalEntryMock).toHaveBeenCalledWith(EXT_INPUT);
    expect(createEntryMock).not.toHaveBeenCalled();
    releaseModel(EXT_INPUT);
  });

  test("does not call loadExternalEntry again for a cached external entry", async () => {
    await acquireModel(EXT_INPUT);
    await acquireModel(EXT_INPUT);
    expect(loadExternalEntryMock).toHaveBeenCalledTimes(1);
    releaseModel(EXT_INPUT);
    releaseModel(EXT_INPUT);
  });
});
