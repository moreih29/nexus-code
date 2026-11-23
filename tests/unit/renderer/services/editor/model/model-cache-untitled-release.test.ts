import { beforeEach, describe, expect, mock, test } from "bun:test";

const cleanupEntry = mock((_entry: unknown) => {});

mock.module("../../../../../../src/renderer/services/editor/lsp/bridge", () => ({
  ensureProvidersFor: () => {},
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  notifyDidSave: () => Promise.resolve(),
  registerKnownModelUri: () => {},
  unregisterKnownModelUri: () => {},
}));

mock.module("../../../../../../src/renderer/services/editor/model/entry", () => ({
  cleanupEntry,
  createEntry: (input: { workspaceId: string; filePath: string }, cacheUri: string) => ({
    input,
    cacheUri,
    lspUri: cacheUri,
    languageId: "typescript",
    refCount: 0,
    phase: "ready",
    model: { id: cacheUri },
    loadPromise: Promise.resolve(),
    subscribers: new Set<() => void>(),
    disposed: false,
    origin: "workspace",
    readOnly: false,
  }),
  createUntitledEntry: (
    input: { workspaceId: string; filePath: string; origin?: string },
    cacheUri: string,
  ) => ({
    input,
    cacheUri,
    lspUri: cacheUri,
    languageId: "plaintext",
    refCount: 0,
    phase: "ready",
    model: { id: cacheUri },
    loadPromise: Promise.resolve(),
    subscribers: new Set<() => void>(),
    disposed: false,
    origin: "untitled",
    readOnly: false,
  }),
  errorCodeFromUnknown: () => "OTHER",
  notifySubscribers: (_entry: unknown) => {},
  rehydrateEntry: (_entry: unknown) => Promise.resolve(),
  reloadEntryFromDisk: (_entry: unknown) => Promise.resolve(),
  snapshot: (entry: { phase: string; model: unknown; readOnly?: boolean }) => ({
    phase: entry.phase,
    model: entry.model,
    readOnly: entry.readOnly ?? false,
  }),
}));

mock.module("../../../../../../src/renderer/services/editor/runtime/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
  requireMonaco: () => {
    throw new Error("requireMonaco should not be called for untitled entries in these tests");
  },
}));

mock.module("../../../../../../src/renderer/services/editor/model/dirty-tracker", () => ({
  attachDirtyTracker: () => {},
  detachDirtyTracker: () => {},
  markSaved: () => {},
  getDirtyEntry: () => undefined,
}));

const { acquireModel, releaseModel, getModelSnapshot } = await import(
  "../../../../../../src/renderer/services/editor/model/cache"
);

const WS = "ws-untitled-test";

function untitledInput(index: number) {
  return {
    workspaceId: WS,
    filePath: `Untitled-${index}`,
    origin: "untitled" as const,
  };
}

describe("untitled model — releaseModel removes cache entry", () => {
  beforeEach(() => {
    cleanupEntry.mockClear();
  });

  test("single acquire + release: entry removed from cache", async () => {
    const input = untitledInput(1);

    await acquireModel(input);
    expect(getModelSnapshot(input)).not.toBeNull();

    releaseModel(input);

    expect(getModelSnapshot(input)).toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(1);
  });

  test("two acquires: entry survives first release, removed on second", async () => {
    const input = untitledInput(2);

    await acquireModel(input);
    await acquireModel(input);

    releaseModel(input);
    expect(getModelSnapshot(input)).not.toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(0);

    releaseModel(input);
    expect(getModelSnapshot(input)).toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(1);
  });

  test("different untitled indices produce independent cache entries", async () => {
    const input1 = untitledInput(3);
    const input2 = untitledInput(4);

    await acquireModel(input1);
    await acquireModel(input2);

    releaseModel(input1);

    expect(getModelSnapshot(input1)).toBeNull();
    expect(getModelSnapshot(input2)).not.toBeNull();

    releaseModel(input2);
    expect(getModelSnapshot(input2)).toBeNull();
  });

  test("releaseModel without prior acquire is a no-op (no crash)", () => {
    const input = untitledInput(99);
    expect(() => releaseModel(input)).not.toThrow();
    expect(cleanupEntry).toHaveBeenCalledTimes(0);
  });
});
