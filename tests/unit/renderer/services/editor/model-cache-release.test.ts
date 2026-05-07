import { beforeEach, describe, expect, mock, test } from "bun:test";

const cleanupEntry = mock((_entry: unknown) => {});

mock.module("../../../../../src/renderer/services/editor/lsp-bridge", () => ({
  ensureProvidersFor: () => {},
  fetchDocumentSymbols: mock(() => Promise.resolve([])),
  monacoContentChangesToLsp: () => [],
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  registerKnownModelUri: () => {},
  unregisterKnownModelUri: () => {},
}));

mock.module("../../../../../src/renderer/services/editor/model-entry", () => ({
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
  }),
  errorCodeFromUnknown: () => "OTHER",
  snapshot: (entry: { phase: string; model: unknown; readOnly?: boolean }) => ({
    phase: entry.phase,
    model: entry.model,
    readOnly: entry.readOnly ?? false,
  }),
}));

mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => true,
  onMonacoReady: () => () => {},
}));

const { acquireModel, releaseModel, subscribeOnRelease } = await import(
  "../../../../../src/renderer/services/editor/model-cache"
);

const INPUT = { workspaceId: "ws-a", filePath: "/workspace/src/a.ts" };
const CACHE_URI = "file:///workspace/src/a.ts";

describe("model-cache subscribeOnRelease", () => {
  beforeEach(() => {
    cleanupEntry.mockClear();
  });

  test("notifies subscribers only when the last reference is released", async () => {
    const released: unknown[] = [];
    const unsubscribe = subscribeOnRelease((info) => released.push(info));

    await acquireModel(INPUT);
    await acquireModel(INPUT);

    releaseModel(INPUT);
    expect(released).toHaveLength(0);
    expect(cleanupEntry).toHaveBeenCalledTimes(0);

    releaseModel(INPUT);

    expect(cleanupEntry).toHaveBeenCalledTimes(1);
    expect(released).toEqual([
      {
        input: INPUT,
        cacheUri: CACHE_URI,
        lspUri: CACHE_URI,
        languageId: "typescript",
      },
    ]);

    unsubscribe();
  });

  test("unsubscribe removes the release listener", async () => {
    const subscriber = mock(() => {});
    const unsubscribe = subscribeOnRelease(subscriber);
    unsubscribe();

    await acquireModel(INPUT);
    releaseModel(INPUT);

    expect(subscriber).toHaveBeenCalledTimes(0);
  });
});
