import { describe, expect, mock, test } from "bun:test";

// Bun mock.module is process-global. We pre-load real exports and spread them
// so other editor/* test files (e.g., save-service.test.ts) see the full module
// surface even after this file has run.
const realMonacoSingleton = await import(
  "../../../../../src/renderer/services/editor/monaco-singleton"
);
const realFileLoader = await import("../../../../../src/renderer/services/editor/file-loader");
const realLspBridge = await import("../../../../../src/renderer/services/editor/lsp-bridge");

mock.module("../../../../../src/renderer/services/editor/monaco-singleton", () => ({
  ...realMonacoSingleton,
  requireMonaco: () => ({
    Uri: {
      parse: (raw: string) => ({
        toString: () => raw,
      }),
    },
  }),
  isMonacoReady: () => false,
}));

// Return a never-resolving promise so loadEntry never progresses past the
// initial readFileForModel call, which means attachDirtyTracker (from the real
// dirty-tracker module) is never invoked.
mock.module("../../../../../src/renderer/services/editor/file-loader", () => ({
  ...realFileLoader,
  readFileForModel: () => new Promise(() => {}),
}));

mock.module("../../../../../src/renderer/services/editor/lsp-bridge", () => ({
  ...realLspBridge,
  ensureProvidersFor: () => {},
  notifyDidChange: () => Promise.resolve(),
  notifyDidClose: () => Promise.resolve(),
  notifyDidOpen: () => Promise.resolve(),
  notifyDidSave: () => Promise.resolve(),
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
