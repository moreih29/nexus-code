/**
 * Unit tests for acquireModel with origin="untitled".
 *
 * When origin="untitled", acquireModel must:
 *   - NOT call createEntry (no fs IPC)
 *   - NOT call loadExternalEntry
 *   - Return a ready-phase model with empty content
 *   - Register a dirty=true state in the dirty tracker (no savePoint)
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Provide a minimal window.ipc stub so ipc/client.ts can be imported.
(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// Stub lsp/bridge so no real IPC is attempted.
const realLspBridge = await import("../../../../../src/renderer/services/editor/lsp/bridge");

mock.module("../../../../../src/renderer/services/editor/lsp/bridge", () => ({
  ...realLspBridge,
  ensureProvidersFor: () => {},
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  notifyDidSave: () => Promise.resolve(),
  registerKnownModelUri: () => {},
  unregisterKnownModelUri: () => {},
}));

// Fake Monaco: tracks created models so tests can inspect them.
const createdModels = new Map<string, { value: string; disposed: boolean }>();

const fakeMonaco = {
  Uri: {
    parse: (raw: string) => ({
      toString: () => raw,
      scheme: raw.split(":")[0],
    }),
  },
  editor: {
    getModel: (_uri: unknown) => null,
    createModel: (content: string, _lang: unknown, uri: unknown) => {
      const key = String((uri as { toString: () => string }).toString());
      const entry = { value: content, disposed: false };
      createdModels.set(key, entry);
      return {
        uri,
        getValue: () => entry.value,
        setValue: (v: string) => {
          entry.value = v;
        },
        getAlternativeVersionId: () => 1,
        getLanguageId: () => "plaintext",
        onDidChangeContent: (_cb: () => void) => ({ dispose: () => {} }),
        isDisposed: () => entry.disposed,
        dispose: () => {
          entry.disposed = true;
        },
      };
    },
  },
};

const realMonacoSingleton = await import(
  "../../../../../src/renderer/services/editor/runtime/monaco-singleton"
);

mock.module("../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  ...realMonacoSingleton,
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => fakeMonaco,
}));

// Track calls to createEntry and loadExternalEntry to verify they are NOT called.
const realModelEntry = await import(
  "../../../../../src/renderer/services/editor/model/entry"
);
const createEntryMock = mock(
  (input: { workspaceId: string; filePath: string }, cacheUri: string) => ({
    input,
    cacheUri,
    lspUri: cacheUri,
    languageId: "",
    refCount: 0,
    phase: "ready" as const,
    model: null,
    lastLoadedValue: "",
    loadPromise: Promise.resolve(),
    subscribers: new Set<() => void>(),
    origin: "workspace" as const,
    readOnly: false,
    disposed: false,
    originatingWorkspaceId: undefined,
    lspOpened: false,
    didOpenPromise: Promise.resolve(),
  }),
);

mock.module("../../../../../src/renderer/services/editor/model/entry", () => ({
  ...realModelEntry,
  createEntry: createEntryMock,
  snapshot: (entry: { phase: string; model: unknown; readOnly?: boolean }) => ({
    phase: entry.phase,
    model: entry.model,
    readOnly: entry.readOnly ?? false,
  }),
}));

const realLoadExternalEntry = await import(
  "../../../../../src/renderer/services/editor/model/load-external-entry"
);
const loadExternalEntryMock = mock(async (input: { workspaceId: string; filePath: string }) => ({
  input: { ...input, origin: "external" as const, readOnly: true },
  cacheUri: `file://${input.filePath}`,
  lspUri: `file://${input.filePath}`,
  languageId: "python",
  refCount: 0,
  phase: "ready" as const,
  model: null,
  lastLoadedValue: "",
  loadPromise: Promise.resolve(),
  subscribers: new Set<() => void>(),
  origin: "external" as const,
  readOnly: true,
  disposed: false,
  originatingWorkspaceId: input.workspaceId,
  lspOpened: false,
  didOpenPromise: Promise.resolve(),
}));

mock.module("../../../../../src/renderer/services/editor/model/load-external-entry", () => ({
  ...realLoadExternalEntry,
  loadExternalEntry: loadExternalEntryMock,
}));

const { acquireModel, getModelSnapshot, releaseModel } = await import(
  "../../../../../src/renderer/services/editor/model/cache"
);
const { isDirty, __resetDirtyTrackerForTests } = await import(
  "../../../../../src/renderer/services/editor/model/dirty-tracker"
);

const WS_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const UNTITLED_INPUT = {
  workspaceId: WS_ID,
  filePath: "Untitled-1",
  origin: "untitled" as const,
};

const UNTITLED_CACHE_URI = `untitled://${WS_ID}/Untitled-1`;

beforeEach(() => {
  // Release any cached entries to keep tests independent.
  releaseModel(UNTITLED_INPUT);
  createEntryMock.mockClear();
  loadExternalEntryMock.mockClear();
  createdModels.clear();
  __resetDirtyTrackerForTests();
});

describe("acquireModel — origin=untitled", () => {
  test("does NOT call createEntry or loadExternalEntry", async () => {
    await acquireModel(UNTITLED_INPUT);
    expect(createEntryMock).not.toHaveBeenCalled();
    expect(loadExternalEntryMock).not.toHaveBeenCalled();
    releaseModel(UNTITLED_INPUT);
  });

  test("returns phase=ready immediately with empty model", async () => {
    const state = await acquireModel(UNTITLED_INPUT);
    expect(state.phase).toBe("ready");
    expect(state.model).not.toBeNull();
    expect(state.model?.getValue()).toBe("");
    releaseModel(UNTITLED_INPUT);
  });

  test("creates Monaco model with the workspace-scoped untitled cacheUri", async () => {
    await acquireModel(UNTITLED_INPUT);
    expect(createdModels.has(UNTITLED_CACHE_URI)).toBe(true);
    releaseModel(UNTITLED_INPUT);
  });

  test("dirty tracker starts as dirty (no savePoint)", async () => {
    await acquireModel(UNTITLED_INPUT);
    expect(isDirty(UNTITLED_CACHE_URI)).toBe(true);
    releaseModel(UNTITLED_INPUT);
  });

  test("second acquire returns cached entry without re-creating", async () => {
    await acquireModel(UNTITLED_INPUT);
    await acquireModel(UNTITLED_INPUT);
    expect(createdModels.size).toBe(1);
    releaseModel(UNTITLED_INPUT);
    releaseModel(UNTITLED_INPUT);
  });

  test("release cleans up the cache entry", async () => {
    await acquireModel(UNTITLED_INPUT);
    releaseModel(UNTITLED_INPUT);
    expect(getModelSnapshot(UNTITLED_INPUT)).toBeNull();
  });

  test("two untitled buffers from the same workspace use distinct cacheUris", async () => {
    const input2 = { ...UNTITLED_INPUT, filePath: "Untitled-2" };
    const cacheUri2 = `untitled://${WS_ID}/Untitled-2`;

    await acquireModel(UNTITLED_INPUT);
    await acquireModel(input2);

    expect(createdModels.has(UNTITLED_CACHE_URI)).toBe(true);
    expect(createdModels.has(cacheUri2)).toBe(true);

    releaseModel(UNTITLED_INPUT);
    releaseModel(input2);
  });
});
