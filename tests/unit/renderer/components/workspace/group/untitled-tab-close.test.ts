/**
 * untitled tab close — Monaco model released from cache
 *
 * Verifies that when handleCloseTab is invoked for an "untitled" tab, the
 * releaseModel call drops the ref-count to zero and removes the entry from
 * the model cache (getModelSnapshot returns null). This is the acceptance
 * criterion from TASK [CRITICAL]: "cache.entries에서 해당 모델 제거됨".
 *
 * The test exercises the real cache module but stubs out Monaco, the LSP
 * bridge, and the entry helpers — the same pattern used by
 * model-cache-release.test.ts — so no Electron/DOM infrastructure is needed.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module stubs — must be registered before any dynamic import of cache.ts
// ---------------------------------------------------------------------------

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

/**
 * Mock entry module — provides both createEntry (for workspace tabs) and
 * createUntitledEntry (for the untitled path under test).
 */
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

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

const { acquireModel, releaseModel, getModelSnapshot } = await import(
  "../../../../../../src/renderer/services/editor/model/cache"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = "ws-untitled-test";

function untitledInput(index: number) {
  return {
    workspaceId: WS,
    filePath: `Untitled-${index}`,
    origin: "untitled" as const,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCloseTab untitled — releaseModel removes cache entry", () => {
  beforeEach(() => {
    cleanupEntry.mockClear();
  });

  test("single acquire + release: entry removed from cache", async () => {
    const input = untitledInput(1);

    await acquireModel(input);
    // Entry must be present before close.
    expect(getModelSnapshot(input)).not.toBeNull();

    // This is what handleCloseTab now calls for tab.type === "untitled".
    releaseModel(input);

    // Cache entry must be gone after the last reference is released.
    expect(getModelSnapshot(input)).toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(1);
  });

  test("two acquires: entry survives first release, removed on second", async () => {
    const input = untitledInput(2);

    await acquireModel(input);
    await acquireModel(input);

    releaseModel(input);
    // Still one ref — entry must survive.
    expect(getModelSnapshot(input)).not.toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(0);

    releaseModel(input);
    // Last ref gone — entry must be removed.
    expect(getModelSnapshot(input)).toBeNull();
    expect(cleanupEntry).toHaveBeenCalledTimes(1);
  });

  test("different untitled indices produce independent cache entries", async () => {
    const input1 = untitledInput(3);
    const input2 = untitledInput(4);

    await acquireModel(input1);
    await acquireModel(input2);

    // Release only the first tab — second must stay in cache.
    releaseModel(input1);

    expect(getModelSnapshot(input1)).toBeNull();
    expect(getModelSnapshot(input2)).not.toBeNull();

    // Cleanup — release the second too.
    releaseModel(input2);
    expect(getModelSnapshot(input2)).toBeNull();
  });

  test("releaseModel without prior acquire is a no-op (no crash)", () => {
    const input = untitledInput(99);
    // Must not throw.
    expect(() => releaseModel(input)).not.toThrow();
    expect(cleanupEntry).toHaveBeenCalledTimes(0);
  });
});
