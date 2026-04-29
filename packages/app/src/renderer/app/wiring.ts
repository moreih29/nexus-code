import { useEffect, useRef } from "react";
import { useStore } from "zustand";

import type { EditorBridgeEvent } from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import {
  createActivityBarService,
  DEFAULT_SIDE_BAR_WIDTH,
  type ActivityBarServiceStore,
} from "../services/activity-bar-service";
import { createBottomPanelService, type BottomPanelServiceStore } from "../services/bottom-panel-service";
import {
  createEditorDocumentsService,
  type EditorDocumentsServiceStore,
} from "../services/editor-documents-service";
import {
  createEditorGroupsService,
  type EditorGroupsServiceStore,
} from "../services/editor-groups-service";
import { DEFAULT_EDITOR_PANE_ID } from "../services/editor-types";
import { createFilesService, type FilesServiceStore } from "../services/files-service";
import { createGitService, type GitServiceStore } from "../services/git-service";
import { createLspService, type LspServiceStore } from "../services/lsp-service";
import { createTerminalService, type TerminalServiceStore } from "../services/terminal-service";
import { createWorkspaceService, type WorkspaceServiceStore } from "../services/workspace-service";
import { fileTreeMultiSelectStore } from "../stores/file-tree-multi-select-store";
import {
  createFileClipboardStore,
  type FileClipboardBridge,
  type FileClipboardStore,
} from "../stores/file-clipboard-store";
import {
  createHarnessBadgeStore,
  type HarnessBadgeStore,
  type HarnessObserverBridge,
} from "../stores/harnessBadgeStore";
import {
  createHarnessSessionStore,
  type HarnessSessionStore,
} from "../stores/harnessSessionStore";
import {
  createHarnessToolFeedStore,
  type HarnessToolFeedStore,
} from "../stores/harnessToolFeedStore";
import { createSearchStore, type SearchBridge, type SearchStore } from "../stores/search-store";
import {
  createSourceControlStore,
  type SourceControlBridge,
  type SourceControlStore,
} from "../stores/source-control-store";
import {
  createWorkspaceStore,
  type WorkspaceSidebarBridge,
  type WorkspaceStore,
} from "../stores/workspace-store";
import type { EditorBridge } from "../services/editor-types";

export const SIDE_BAR_STORAGE_KEY = "nx.layout.sideBar";
export const SIDE_BAR_MIN_SIZE = 220;
export const SIDE_BAR_MAX_SIZE = 420;

export interface StoredPanelState {
  size: number;
}

interface PanelStateStorage {
  getItem(key: string): string | null;
}

export interface AppServiceDependencies {
  editorBridge?: EditorBridge;
  fileClipboardBridge?: FileClipboardBridge;
  harnessBridge?: HarnessObserverBridge;
  searchBridge?: SearchBridge;
  sourceControlBridge?: SourceControlBridge;
  storage?: PanelStateStorage | null;
  workspaceBridge?: WorkspaceSidebarBridge;
}

export interface AppServices {
  activityBar: ActivityBarServiceStore;
  bottomPanel: BottomPanelServiceStore;
  editorDocuments: EditorDocumentsServiceStore;
  editorGroups: EditorGroupsServiceStore;
  editorWorkspace: WorkspaceServiceStore;
  fileClipboard: FileClipboardStore;
  files: FilesServiceStore;
  git: GitServiceStore;
  harnessBadge: HarnessBadgeStore;
  harnessSession: HarnessSessionStore;
  harnessToolFeed: HarnessToolFeedStore;
  lsp: LspServiceStore;
  search: SearchStore;
  sourceControl: SourceControlStore;
  terminal: TerminalServiceStore;
  workspace: WorkspaceStore;
}

export function useAppServices(): AppServices {
  const servicesRef = useRef<AppServices | null>(null);

  if (!servicesRef.current) {
    servicesRef.current = createAppServices();
  }

  useAppServiceBridgeSubscriptions(servicesRef.current);

  return servicesRef.current;
}

export function createAppServices(dependencies: AppServiceDependencies = {}): AppServices {
  const resolvedDependencies = resolveAppServiceDependencies(dependencies);

  return {
    activityBar: createActivityBarService({
      sideBarWidth: readStoredPanelState(
        SIDE_BAR_STORAGE_KEY,
        DEFAULT_SIDE_BAR_WIDTH,
        SIDE_BAR_MIN_SIZE,
        SIDE_BAR_MAX_SIZE,
        resolvedDependencies.storage,
      ).size,
    }),
    bottomPanel: createBottomPanelService(),
    editorDocuments: createEditorDocumentsService(resolvedDependencies.editorBridge),
    editorGroups: createEditorGroupsService({
      groups: [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [], activeTabId: null }],
      activeGroupId: DEFAULT_EDITOR_PANE_ID,
    }),
    editorWorkspace: createWorkspaceService(),
    fileClipboard: createFileClipboardStore(resolvedDependencies.fileClipboardBridge),
    files: createFilesService(resolvedDependencies.editorBridge),
    git: createGitService(),
    harnessBadge: createHarnessBadgeStore(resolvedDependencies.harnessBridge),
    harnessSession: createHarnessSessionStore(resolvedDependencies.harnessBridge),
    harnessToolFeed: createHarnessToolFeedStore(resolvedDependencies.harnessBridge),
    lsp: createLspService(),
    search: createSearchStore(resolvedDependencies.searchBridge),
    sourceControl: createSourceControlStore(resolvedDependencies.sourceControlBridge),
    terminal: createTerminalService(),
    workspace: createWorkspaceStore(resolvedDependencies.workspaceBridge),
  };
}

export function mountAppServiceLifecycles(services: Pick<AppServices, "terminal">): () => void {
  return services.terminal.getState().mountShell();
}

export function readStoredPanelState(
  storageKey: string,
  fallbackSize: number,
  minSize: number,
  maxSize: number,
  storage: PanelStateStorage | null = globalThis.window?.localStorage ?? null,
): StoredPanelState {
  const fallbackState = { size: fallbackSize };

  try {
    const rawValue = storage?.getItem(storageKey);

    if (!rawValue) {
      return fallbackState;
    }

    const parsedValue = JSON.parse(rawValue) as Partial<{ size: unknown }>;

    if (
      typeof parsedValue.size === "number" &&
      Number.isFinite(parsedValue.size) &&
      parsedValue.size >= minSize &&
      parsedValue.size <= maxSize
    ) {
      return { size: parsedValue.size };
    }

    return fallbackState;
  } catch {
    return fallbackState;
  }
}

export async function refreshEditorFileTreeAndGitBadges(
  filesService: FilesServiceStore,
  gitService: GitServiceStore,
  workspaceId?: WorkspaceId | null,
): Promise<void> {
  const refreshedWorkspaceId = workspaceId ?? filesService.getState().workspaceId;
  const result = await filesService.getState().refreshFileTree(refreshedWorkspaceId);
  if (result) {
    syncGitBadgesFromFiles(filesService, gitService, result.workspaceId);
  }
}

export function syncGitBadgesFromFiles(
  filesService: FilesServiceStore,
  gitService: GitServiceStore,
  workspaceId: WorkspaceId,
): void {
  gitService.getState().replacePathBadges(workspaceId, filesService.getState().gitBadgeByPath);
}

function useAppServiceBridgeSubscriptions(services: AppServices): void {
  const activeWorkspaceId = useStore(services.workspace, (state) => state.sidebarState.activeWorkspaceId);

  useEffect(() => mountAppServiceLifecycles(services), [services]);

  useEffect(() => {
    void services.workspace.getState().refreshSidebarState().catch((error) => {
      console.error("Workspace sidebar: failed to load sidebar state.", error);
    });

    const subscription = window.nexusWorkspace.onSidebarStateChanged((nextState) => {
      services.workspace.getState().applySidebarState(nextState);
    });

    return () => {
      subscription.dispose();
    };
  }, [services.workspace]);

  useEffect(() => {
    services.harnessBadge.getState().startObserverSubscription();
    services.harnessToolFeed.getState().startObserverSubscription();
    services.harnessSession.getState().startObserverSubscription();

    return () => {
      services.harnessBadge.getState().stopObserverSubscription();
      services.harnessToolFeed.getState().stopObserverSubscription();
      services.harnessSession.getState().stopObserverSubscription();
    };
  }, [services.harnessBadge, services.harnessSession, services.harnessToolFeed]);

  useEffect(() => {
    services.search.getState().startBridgeSubscription();
    services.sourceControl.getState().startBridgeSubscription();

    return () => {
      services.search.getState().stopBridgeSubscription();
      services.sourceControl.getState().stopBridgeSubscription();
    };
  }, [services.search, services.sourceControl]);

  useEffect(() => {
    const subscription = window.nexusEditor.onEvent((event) => {
      applyEditorBridgeEventToDestinationServices(event, services);
    });

    return () => {
      subscription.dispose();
    };
  }, [services]);

  useEffect(() => {
    fileTreeMultiSelectStore.getState().clearSelect();
    fileTreeMultiSelectStore.getState().clearCompareAnchor();
    services.files.getState().setActiveWorkspace(activeWorkspaceId);
    services.terminal.getState().setActiveWorkspace(activeWorkspaceId);
    activateWorkspaceEditorTabs(services.editorGroups, activeWorkspaceId);

    if (activeWorkspaceId) {
      void refreshEditorFileTreeAndGitBadges(services.files, services.git, activeWorkspaceId).catch((error) => {
        console.error("File tree: failed to refresh active workspace.", error);
      });
    } else {
      services.git.getState().clear();
    }
  }, [activeWorkspaceId, services.editorGroups, services.files, services.git, services.terminal]);
}

function applyEditorBridgeEventToDestinationServices(
  event: EditorBridgeEvent,
  services: Pick<AppServices, "editorDocuments" | "files" | "git" | "lsp">,
): void {
  switch (event.type) {
    case "workspace-files/watch":
      if (event.workspaceId === services.files.getState().workspaceId) {
        void refreshEditorFileTreeAndGitBadges(services.files, services.git, event.workspaceId);
      }
      return;
    case "workspace-git-badges/changed":
      if (event.workspaceId === services.files.getState().workspaceId) {
        services.git.getState().applyPathBadges(event.workspaceId, event.badges);
      }
      return;
    case "lsp-diagnostics/changed":
      services.editorDocuments.getState().setDiagnostics(event.workspaceId, event.path, event.diagnostics);
      services.lsp.getState().applyDiagnosticsEvent(event);
      return;
    case "lsp-status/changed":
      services.editorDocuments.getState().setLspStatus(event.workspaceId, event.status);
      services.lsp.getState().applyStatusEvent(event);
      return;
  }
}

function activateWorkspaceEditorTabs(
  groupsService: EditorGroupsServiceStore,
  workspaceId: WorkspaceId | null,
): void {
  const state = groupsService.getState();
  const groups = state.groups.map((group) => {
    const activeTabInWorkspace = workspaceId && group.activeTabId
      ? group.tabs.find((tab) => tab.id === group.activeTabId && tab.workspaceId === workspaceId)
      : null;
    const nextActiveTab = activeTabInWorkspace ?? (
      workspaceId ? group.tabs.find((tab) => tab.workspaceId === workspaceId) : null
    );
    return {
      ...group,
      activeTabId: nextActiveTab?.id ?? null,
    };
  });
  state.setGroups(groups, state.activeGroupId ?? groups[0]?.id ?? null);
}

function resolveAppServiceDependencies(
  dependencies: AppServiceDependencies,
): Required<Omit<AppServiceDependencies, "storage">> & { storage: PanelStateStorage | null } {
  const rendererWindow = globalThis.window as (Window & typeof globalThis) | undefined;

  return {
    editorBridge: dependencies.editorBridge ?? requireRendererWindow(rendererWindow).nexusEditor,
    fileClipboardBridge: dependencies.fileClipboardBridge ?? requireRendererWindow(rendererWindow).nexusFileActions,
    harnessBridge: dependencies.harnessBridge ?? requireRendererWindow(rendererWindow).nexusHarness,
    searchBridge: dependencies.searchBridge ?? requireRendererWindow(rendererWindow).nexusSearch,
    sourceControlBridge: dependencies.sourceControlBridge ?? requireRendererWindow(rendererWindow).nexusGit,
    storage: dependencies.storage === undefined ? rendererWindow?.localStorage ?? null : dependencies.storage,
    workspaceBridge: dependencies.workspaceBridge ?? requireRendererWindow(rendererWindow).nexusWorkspace,
  };
}

function requireRendererWindow(
  rendererWindow: (Window & typeof globalThis) | undefined,
): Window & typeof globalThis {
  if (!rendererWindow) {
    throw new Error("App services require the renderer preload APIs on window.");
  }

  return rendererWindow;
}
