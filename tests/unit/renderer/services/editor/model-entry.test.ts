import { describe, expect, mock, test } from "bun:test";

// Stub the monaco singleton. This mock persists in the bun process, but
// model-cache-release.test.ts already mocks monaco-singleton the same way,
// so running both files together is safe.
mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
  requireMonaco: () => ({
    Uri: {
      parse: (raw: string) => ({
        toString: () => raw,
      }),
    },
  }),
  initializeMonacoSingleton: () => {},
  isMonacoReady: () => false,
  onMonacoReady: () => () => {},
}));

// Return a never-resolving promise so loadEntry never progresses past the
// initial readFileForModel call, which means attachDirtyTracker (from the real
// dirty-tracker module) is never invoked.  This avoids the need to mock
// dirty-tracker, which would break dirty-tracker.test.ts when both files run
// in the same bun session.
mock.module("../../../../../src/renderer/services/editor/file-loader", () => ({
  readFileForModel: () => new Promise(() => {}),
  subscribeFsChanged: () => () => {},
  workspaceRootForInput: () => "/workspace",
}));

mock.module("../../../../../src/renderer/services/editor/lsp-bridge", () => ({
  ensureProvidersFor: () => {},
  monacoContentChangesToLsp: () => [],
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  registerKnownModelUri: () => {},
  unregisterKnownModelUri: () => {},
}));

const { createEntry, snapshot } = await import(
  "../../../../../src/renderer/services/editor/model-entry"
);

const WORKSPACE_INPUT = { workspaceId: "ws-1", filePath: "/workspace/src/a.ts" };
const CACHE_URI = "file:///workspace/src/a.ts";

describe("ModelEntry construction — origin/readOnly fields", () => {
  test("defaults to origin=workspace and readOnly=false when not specified", () => {
    const entry = createEntry(WORKSPACE_INPUT, CACHE_URI);
    expect(entry.origin).toBe("workspace");
    expect(entry.readOnly).toBe(false);
    expect(entry.originatingWorkspaceId).toBeUndefined();
  });

  test("preserves explicit origin=workspace and readOnly=false", () => {
    const entry = createEntry(
      { ...WORKSPACE_INPUT, origin: "workspace", readOnly: false },
      CACHE_URI,
    );
    expect(entry.origin).toBe("workspace");
    expect(entry.readOnly).toBe(false);
    expect(entry.originatingWorkspaceId).toBeUndefined();
  });

  test("sets origin=external and readOnly=true for an external read-only input", () => {
    const externalInput = {
      workspaceId: "ws-1",
      filePath: "/some/external/file.ts",
      origin: "external" as const,
      readOnly: true,
    };
    const entry = createEntry(externalInput, "file:///some/external/file.ts");
    expect(entry.origin).toBe("external");
    expect(entry.readOnly).toBe(true);
    expect(entry.originatingWorkspaceId).toBe("ws-1");
  });

  test("snapshot includes readOnly=true from external entry", () => {
    const entry = createEntry(
      { ...WORKSPACE_INPUT, origin: "external", readOnly: true },
      CACHE_URI,
    );
    // Entry starts in loading phase (loadEntry is pending), so snapshot.model is null.
    const snap = snapshot(entry);
    expect(snap.readOnly).toBe(true);
  });

  test("snapshot includes readOnly=false from default workspace entry", () => {
    const entry = createEntry(WORKSPACE_INPUT, CACHE_URI);
    const snap = snapshot(entry);
    expect(snap.readOnly).toBe(false);
  });
});
