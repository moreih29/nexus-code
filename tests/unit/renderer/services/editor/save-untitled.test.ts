/**
 * Unit tests for saveUntitledModel — the first-save flow for untitled buffers.
 *
 * Three scenarios:
 *   1. Happy path — user picks a workspace-inside path → tab replaced, untitled released.
 *   2. User cancels the save dialog → untitled tab preserved, no error.
 *   3. fs.writeFile error → toast called, untitled tab preserved.
 */

(globalThis as Record<string, unknown>).window = {
  ipc: {
    call: () => Promise.resolve(null),
    listen: () => {},
    off: () => {},
  },
};

// ── Mock ipcCallResult ────────────────────────────────────────────────────────
const ipcCallMock = mock(
  (_service: unknown, _method: unknown, _args: unknown): Promise<unknown> =>
    Promise.resolve({ ok: true as const, value: { canceled: false, filePath: null } }),
);

mock.module("../../../../../src/renderer/ipc/client", () => ({
  ipcCallResult: ipcCallMock,
  ipcListen: () => () => {},
  unwrapIpcResult: (result: { ok: boolean; value?: unknown; error?: string }) => {
    if (!result.ok) throw new Error(result.error ?? "IPC error");
    return result.value;
  },
  mustSucceed: (result: { ok: boolean; value?: unknown; error?: string }) => {
    if (!result.ok) throw new Error(result.error ?? "IPC error");
    return result.value;
  },
  canUseIpcBridge: () => true,
}));

// ── Mock toast ────────────────────────────────────────────────────────────────
const showToastMock = mock((_input: unknown) => {});

mock.module("../../../../../src/renderer/components/ui/toast", () => ({
  showToast: showToastMock,
}));

// ── Mock model cache ──────────────────────────────────────────────────────────
const makeModel = (value = "hello world") => ({
  getValue: () => value,
  getAlternativeVersionId: () => 1,
});

const getResolvedModelMock = mock((_input: unknown) => ({
  model: makeModel(),
  cacheUri: "untitled://ws-1/Untitled-1",
  workspaceId: "ws-1",
  filePath: "Untitled-1",
  languageId: "plaintext",
  readOnly: false,
}));
const acquireModelMock = mock((_input: unknown) => Promise.resolve({}));
const releaseModelMock = mock((_input: unknown) => {});
const markSavedMock = mock((_opts: unknown) => {});

const realModelCache = await import(
  "../../../../../src/renderer/services/editor/model/cache"
);

mock.module("../../../../../src/renderer/services/editor/model/cache", () => ({
  ...realModelCache,
  getResolvedModel: getResolvedModelMock,
  acquireModel: acquireModelMock,
  releaseModel: releaseModelMock,
}));

// ── Mock dirty-tracker ────────────────────────────────────────────────────────
mock.module("../../../../../src/renderer/services/editor/model/dirty-tracker", () => ({
  markSaved: markSavedMock,
  getDirtyEntry: () => undefined,
  attachDirtyTracker: () => {},
  detachDirtyTracker: () => {},
}));

// ── Mock tabs store ───────────────────────────────────────────────────────────
const replaceUntitledWithEditorMock = mock(
  (_workspaceId: unknown, _tabId: unknown, _props: unknown, _title: unknown) => {},
);

// Tabs store getState() must be callable. We return a frozen snapshot with
// enough surface area for saveUntitledModel.
const tabsStateMock = {
  byWorkspace: {
    "ws-1": {
      "tab-1": {
        id: "tab-1",
        type: "untitled" as const,
        title: "Untitled-1",
        isPreview: false,
        isPinned: false,
        props: { untitledIndex: 1 },
      },
    },
  },
  replaceUntitledWithEditor: replaceUntitledWithEditorMock,
};

mock.module("../../../../../src/renderer/state/stores/tabs", () => ({
  useTabsStore: {
    getState: () => tabsStateMock,
  },
}));

// ── Mock workspaces store ─────────────────────────────────────────────────────
mock.module("../../../../../src/renderer/state/stores/workspaces", () => ({
  useWorkspacesStore: {
    getState: () => ({
      workspaces: [
        {
          id: "ws-1",
          rootPath: "/home/user/project",
        },
      ],
    }),
  },
}));

// ── Mock promote-policy (used by saveModel, not saveUntitledModel) ────────────
mock.module("../../../../../src/renderer/services/editor/tabs/promote-policy", () => ({
  promoteAllPreviewTabsForFile: () => {},
}));

// ── Mock lsp/bridge ───────────────────────────────────────────────────────────
mock.module("../../../../../src/renderer/services/editor/lsp/bridge", () => ({
  notifyDidSave: () => Promise.resolve(),
  registerKnownModelUri: () => {},
}));

// ── Mock conflict dialog (pulled in transitively) ─────────────────────────────
mock.module("../../../../../src/renderer/components/editor/conflict-dialog", () => ({
  showConflictResolution: () => Promise.resolve("cancel"),
  ConflictResolutionDialogRoot: () => null,
  __resetConflictDialogForTests: () => {},
}));

// ── Mock file-loader ──────────────────────────────────────────────────────────
mock.module("../../../../../src/renderer/services/editor/model/file-loader", () => ({
  relPathForInput: (_input: unknown) => "src/a.ts",
  workspaceRootForInput: (_input: unknown) => "/home/user/project",
}));

import { afterEach, describe, expect, mock, test } from "bun:test";
const { saveUntitledModel } = await import(
  "../../../../../src/renderer/services/editor/save/save-untitled-handler"
);

// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => {
  ipcCallMock.mockClear();
  showToastMock.mockClear();
  getResolvedModelMock.mockClear();
  acquireModelMock.mockClear();
  releaseModelMock.mockClear();
  markSavedMock.mockClear();
  replaceUntitledWithEditorMock.mockClear();

  // Restore defaults.
  getResolvedModelMock.mockImplementation(() => ({
    model: makeModel(),
    cacheUri: "untitled://ws-1/Untitled-1",
    workspaceId: "ws-1",
    filePath: "Untitled-1",
    languageId: "plaintext",
    readOnly: false,
  }));
  acquireModelMock.mockImplementation(() => Promise.resolve({}));
  releaseModelMock.mockImplementation(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Normal save (workspace-inside path chosen)
// ─────────────────────────────────────────────────────────────────────────────

describe("saveUntitledModel — normal save (workspace-inside path)", () => {
  test("replaces tab with editor type and releases untitled model", async () => {
    const chosenPath = "/home/user/project/src/new-file.ts";

    // showSaveDialog → user picks a path
    ipcCallMock.mockImplementation(
      (_service: unknown, method: unknown, _args: unknown): Promise<unknown> => {
        if (method === "showSaveDialog") {
          return Promise.resolve({
            ok: true,
            value: { canceled: false, filePath: chosenPath },
          });
        }
        // writeFile → success
        return Promise.resolve({
          ok: true,
          value: { kind: "ok", mtime: "T1", size: 55 },
        });
      },
    );

    await saveUntitledModel("ws-1", "tab-1");

    // Tab must be replaced with editor type.
    expect(replaceUntitledWithEditorMock).toHaveBeenCalledTimes(1);
    const replaceArgs = replaceUntitledWithEditorMock.mock.calls[0] as [
      string,
      string,
      { workspaceId: string; filePath: string; origin: string },
      string,
    ];
    expect(replaceArgs[0]).toBe("ws-1");
    expect(replaceArgs[1]).toBe("tab-1");
    expect(replaceArgs[2]).toMatchObject({
      workspaceId: "ws-1",
      filePath: chosenPath,
      origin: "workspace",
    });
    expect(replaceArgs[3]).toBe("new-file.ts");

    // Untitled model must be released.
    expect(releaseModelMock).toHaveBeenCalledTimes(1);
    expect((releaseModelMock.mock.calls[0] as [{ origin: string }])[0]).toMatchObject({
      origin: "untitled",
    });

    // No error toast.
    expect(showToastMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — User cancels the dialog
// ─────────────────────────────────────────────────────────────────────────────

describe("saveUntitledModel — user cancels save dialog", () => {
  test("does nothing: untitled tab preserved, no toast, no release", async () => {
    ipcCallMock.mockImplementation(
      (_service: unknown, _method: unknown, _args: unknown): Promise<unknown> =>
        Promise.resolve({ ok: true, value: { canceled: true, filePath: undefined } }),
    );

    await saveUntitledModel("ws-1", "tab-1");

    expect(replaceUntitledWithEditorMock).not.toHaveBeenCalled();
    expect(releaseModelMock).not.toHaveBeenCalled();
    expect(showToastMock).not.toHaveBeenCalled();
    // writeFile must NOT have been called.
    const writeFileCalls = (ipcCallMock.mock.calls as Array<[string, string, unknown]>).filter(
      ([_svc, method]) => method === "writeFile",
    );
    expect(writeFileCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — fs.writeFile error
// ─────────────────────────────────────────────────────────────────────────────

describe("saveUntitledModel — fs error during write", () => {
  test("shows error toast and preserves untitled tab", async () => {
    const chosenPath = "/home/user/project/src/fail.ts";

    ipcCallMock.mockImplementation(
      (_service: unknown, method: unknown, _args: unknown): Promise<unknown> => {
        if (method === "showSaveDialog") {
          return Promise.resolve({
            ok: true,
            value: { canceled: false, filePath: chosenPath },
          });
        }
        // writeFile → IPC-level error (ok:false)
        return Promise.resolve({ ok: false, error: "EACCES: permission denied" });
      },
    );

    await saveUntitledModel("ws-1", "tab-1");

    // Toast with error must be shown.
    expect(showToastMock).toHaveBeenCalledTimes(1);
    const toastArg = (showToastMock.mock.calls[0] as [{ kind: string; message: string }])[0];
    expect(toastArg.kind).toBe("error");
    expect(toastArg.message).toContain("Save failed");

    // Untitled tab must NOT be replaced.
    expect(replaceUntitledWithEditorMock).not.toHaveBeenCalled();
    // Untitled model must NOT be released.
    expect(releaseModelMock).not.toHaveBeenCalled();
  });
});
