import { describe, expect, test } from "bun:test";

import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import {
  createWorkspaceService,
  getWorkspaceLayoutStorageKey,
  type WorkspaceLayoutSnapshot,
  type WorkspaceLayoutStorage,
} from "./workspace-service";
import { LEGACY_EDITOR_PANES_STORAGE_KEY } from "./editor-groups-service";

const alphaId = "ws_alpha" as WorkspaceId;
const betaId = "ws_beta" as WorkspaceId;
const gammaId = "ws_gamma" as WorkspaceId;

describe("IWorkspaceService", () => {
  test("opens, activates, closes, and notifies workspace subscribers", () => {
    const store = createWorkspaceService({}, { storage: createMemoryStorage() });
    const alpha = createWorkspace(alphaId, "Alpha");
    const beta = createWorkspace(betaId, "Beta");
    const activeWorkspaceIds: Array<WorkspaceId | null> = [];

    const unsubscribe = store.getState().onWorkspaceChanged((snapshot) => {
      activeWorkspaceIds.push(snapshot.activeWorkspaceId);
    });

    store.getState().openWorkspace(alpha);
    store.getState().openWorkspace(beta);
    store.getState().activateWorkspace(alphaId);

    expect(store.getState().getOpenWorkspaces()).toEqual([alpha, beta]);
    expect(store.getState().getActive()).toEqual(alpha);
    expect(store.getState().getActiveWorkspace()).toEqual(alpha);
    expect(activeWorkspaceIds).toEqual([alphaId, betaId, alphaId]);

    unsubscribe();
    store.getState().closeWorkspace(alphaId);

    expect(store.getState().getOpenWorkspaces()).toEqual([beta]);
    expect(store.getState().getActiveWorkspace()).toEqual(beta);
    expect(activeWorkspaceIds).toEqual([alphaId, betaId, alphaId]);
  });

  test("persists three simultaneous workspace layouts by per-workspace flexlayout key", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceService({}, { storage });
    const alpha = createWorkspace(alphaId, "Alpha");
    const beta = createWorkspace(betaId, "Beta");
    const gamma = createWorkspace(gammaId, "Gamma");
    const alphaLayout = createLayout(alphaId, "alpha.ts");
    const betaLayout = createLayout(betaId, "beta.ts");
    const gammaLayout = createLayout(gammaId, "gamma.ts");

    store.getState().openWorkspace(alpha);
    store.getState().openWorkspace(beta);
    store.getState().openWorkspace(gamma);
    store.getState().saveLayoutModel(alphaId, alphaLayout);
    store.getState().saveLayoutModel(betaId, betaLayout);
    store.getState().saveLayoutModel(gammaId, gammaLayout);

    expect(JSON.parse(storage.getItem(getWorkspaceLayoutStorageKey(alphaId)) ?? "")).toEqual(alphaLayout);
    expect(JSON.parse(storage.getItem(getWorkspaceLayoutStorageKey(betaId)) ?? "")).toEqual(betaLayout);
    expect(JSON.parse(storage.getItem(getWorkspaceLayoutStorageKey(gammaId)) ?? "")).toEqual(gammaLayout);

    store.getState().activateWorkspace(betaId);
    expect(store.getState().getActiveWorkspace()).toEqual(beta);
    expect(store.getState().getLayoutModel(betaId)).toEqual(betaLayout);

    store.getState().activateWorkspace(alphaId);
    expect(store.getState().getActiveWorkspace()).toEqual(alpha);
    expect(store.getState().getLayoutModel(alphaId)).toEqual(alphaLayout);

    store.getState().activateWorkspace(gammaId);
    expect(store.getState().getActiveWorkspace()).toEqual(gamma);
    expect(store.getState().getLayoutModel(gammaId)).toEqual(gammaLayout);

    const reloadedStore = createWorkspaceService({
      openWorkspaces: [alpha, beta, gamma],
      activeWorkspaceId: alphaId,
    }, { storage });

    expect(reloadedStore.getState().getLayoutModel(alphaId)).toEqual(alphaLayout);
    reloadedStore.getState().activateWorkspace(betaId);
    expect(reloadedStore.getState().getLayoutModel(betaId)).toEqual(betaLayout);
    reloadedStore.getState().activateWorkspace(gammaId);
    expect(reloadedStore.getState().getLayoutModel(gammaId)).toEqual(gammaLayout);
  });

  test("keeps legacy layout accessors compatible with service skeleton contract", () => {
    const storage = createMemoryStorage();
    const store = createWorkspaceService({}, { storage });
    const alpha = createWorkspace(alphaId, "Alpha");
    const beta = createWorkspace(betaId, "Beta");
    const layout = createLayout(alphaId, "legacy.ts");

    store.getState().openWorkspace(alpha);
    store.getState().openWorkspace(beta);
    store.getState().activateWorkspace(alphaId);
    store.getState().persistLayout(alphaId, layout);

    expect(store.getState().getPersistedLayout(alphaId)).toEqual(layout);

    store.getState().closeWorkspace(alphaId);

    expect(store.getState().getPersistedLayout(alphaId)).toBeNull();
    expect(storage.getItem(getWorkspaceLayoutStorageKey(alphaId))).toBeNull();
    expect(store.getState().activeWorkspaceId).toBe(betaId);
  });

  test("returns null instead of throwing when stored layout JSON is corrupt", () => {
    const storage = createMemoryStorage();
    storage.setItem(getWorkspaceLayoutStorageKey(alphaId), "{not-json");
    storage.setItem(getWorkspaceLayoutStorageKey(betaId), "[]");
    const store = createWorkspaceService({}, { storage });

    expect(() => store.getState().getLayoutModel(alphaId)).not.toThrow();
    expect(store.getState().getLayoutModel(alphaId)).toBeNull();
    expect(store.getState().getLayoutModel(betaId)).toBeNull();

    store.getState().openWorkspace(createWorkspace(alphaId, "Alpha"));

    expect(store.getState().getActiveWorkspace()?.id).toBe(alphaId);
    expect(store.getState().getLayoutModel(alphaId)).toBeNull();
  });

  test("migrates legacy nx.editor.panes storage into the per-workspace flexlayout key", () => {
    const storage = createMemoryStorage({
      [LEGACY_EDITOR_PANES_STORAGE_KEY]: JSON.stringify({
        panes: [
          { id: "p0", tabs: [createLegacyTab(alphaId, "alpha.ts")], activeTabId: `${alphaId}::alpha.ts` },
          { id: "p1", tabs: [createLegacyTab(alphaId, "beta.ts")], activeTabId: `${alphaId}::beta.ts` },
        ],
        activePaneId: "p1",
      }),
    });
    const store = createWorkspaceService({}, { storage });
    const layout = store.getState().getLayoutModel(alphaId);

    expect(layout?.layout).toMatchObject({
      type: "row",
      children: [
        { id: "p0", children: [{ id: `${alphaId}::alpha.ts` }] },
        { id: "p1", active: true, children: [{ id: `${alphaId}::beta.ts` }] },
      ],
    });
    expect(JSON.parse(storage.getItem(getWorkspaceLayoutStorageKey(alphaId)) ?? "")).toEqual(layout);
  });

  test("falls back to default flexlayout and emits migration warnings for damaged legacy panes", () => {
    const storage = createMemoryStorage({ [LEGACY_EDITOR_PANES_STORAGE_KEY]: "{not-json" });
    const warnings: string[] = [];
    const store = createWorkspaceService({}, {
      storage,
      onLayoutMigrationWarning(warning) {
        warnings.push(warning.message);
      },
    });
    const layout = store.getState().getLayoutModel(alphaId);

    expect(warnings).toHaveLength(1);
    expect(layout?.layout).toMatchObject({
      type: "row",
      children: [{ id: "group_main", children: [] }],
    });
  });

  test("migrates and persists center workbench mode independently of workspace layouts", () => {
    const storage = createMemoryStorage({ "nx.center.mode": JSON.stringify({ mode: "editor" }) });
    const store = createWorkspaceService({}, { storage });

    expect(store.getState().centerMode).toBe("editor-max");

    store.getState().toggleCenterWorkbenchMaximize("editor");
    expect(store.getState().centerMode).toBe("split");
    expect(storage.getItem("nx.center.mode")).toBe("split");

    store.getState().setCenterMode("terminal-max");
    expect(store.getState().centerMode).toBe("terminal-max");
    expect(storage.getItem("nx.center.mode")).toBe("terminal-max");
  });
});

function createWorkspace(id: WorkspaceId, displayName: string): OpenSessionWorkspace {
  return {
    id,
    absolutePath: `/tmp/${displayName.toLowerCase()}`,
    displayName,
  };
}

function createLegacyTab(workspaceId: WorkspaceId, path: string): Record<string, unknown> {
  return {
    id: `${workspaceId}::${path}`,
    kind: "file",
    workspaceId,
    path,
    title: path,
    content: "",
    savedContent: "",
    version: "v1",
    dirty: false,
    saving: false,
    errorMessage: null,
    language: "typescript",
    monacoLanguage: "typescript",
    lspDocumentVersion: 1,
    diagnostics: [],
    lspStatus: null,
  };
}

function createLayout(workspaceId: WorkspaceId, tabName: string): WorkspaceLayoutSnapshot {
  return {
    global: {
      enableEdgeDock: true,
      tabSetEnableDeleteWhenEmpty: false,
    },
    borders: [
      {
        type: "border",
        location: "bottom",
        children: [
          {
            type: "tab",
            id: `terminal_${workspaceId}`,
            name: "Terminal",
            component: "nexus-editor-group-tab",
          },
        ],
      },
    ],
    layout: {
      type: "row",
      id: `root_${workspaceId}`,
      children: [
        {
          type: "tabset",
          id: `group_${workspaceId}`,
          selected: 0,
          children: [
            {
              type: "tab",
              id: `tab_${workspaceId}`,
              name: tabName,
              component: "nexus-editor-group-tab",
              config: {
                editorGroupTab: {
                  id: `tab_${workspaceId}`,
                  title: tabName,
                  kind: "file",
                  workspaceId,
                  resourcePath: `src/${tabName}`,
                },
              },
            },
          ],
        },
      ],
    },
  };
}

function createMemoryStorage(initialEntries: Record<string, string> = {}): WorkspaceLayoutStorage {
  const entries = new Map(Object.entries(initialEntries));

  return {
    getItem(key) {
      return entries.get(key) ?? null;
    },
    setItem(key, value) {
      entries.set(key, value);
    },
    removeItem(key) {
      entries.delete(key);
    },
  };
}
