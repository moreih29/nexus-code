import { type Model } from "flexlayout-react";
import { useCallback, useMemo } from "react";
import { useStore } from "zustand";

import type {
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
  WorkspaceFileKind,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import type { OpenSessionWorkspace } from "../../../../shared/src/contracts/workspace/workspace-shell";
import { type EditorDocument, type EditorDocumentsServiceStore } from "../services/editor-documents-service";
import {
  type DropExternalEditorPayloadInput,
  type EditorGroup,
  type EditorGroupId,
  type EditorGroupSpatialDirection,
  type EditorGroupTab,
  type EditorGroupSplitDirection,
  type EditorGroupsLayoutSnapshot,
  type EditorGroupsServiceStore,
} from "../services/editor-groups-service";
import type { FilesServiceStore } from "../services/files-service";
import type { GitServiceStore } from "../services/git-service";
import {
  DEFAULT_EDITOR_PANE_ID,
  MAX_EDITOR_PANE_COUNT,
  SECONDARY_EDITOR_PANE_ID,
  detectLspLanguage,
  diffTabIdFor,
  monacoLanguageIdForPath,
  tabIdFor,
  titleForPath,
  type EditorDiffSide,
  type EditorPaneId,
  type EditorPaneState,
  type EditorTab,
  type EditorTabId,
  type ExternalEditorDropPayload,
  type OpenDiffTabOptions,
  type OpenDiffTabSide,
} from "../services/editor-types";
import type { WorkspaceServiceStore } from "../services/workspace-service";
import { refreshEditorFileTreeAndGitBadges } from "./wiring";

export interface UseEditorBindingsInput {
  activeWorkspaceId: WorkspaceId | null;
  documentsService: EditorDocumentsServiceStore;
  filesService: FilesServiceStore;
  gitService: GitServiceStore;
  groupsService: EditorGroupsServiceStore;
  openWorkspaces?: readonly OpenSessionWorkspace[];
  workspaceService: WorkspaceServiceStore;
}

export interface EditorBindings {
  activeGroupId: EditorGroupId | null;
  activePaneId: EditorPaneId;
  groups: EditorGroup[];
  layoutSnapshot: EditorGroupsLayoutSnapshot | null;
  model: Model;
  panes: EditorPaneState[];
  activatePane(paneId: EditorPaneId): void;
  activateTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  applyWorkspaceEdit(workspaceId: WorkspaceId, edit: LspWorkspaceEdit): Promise<LspWorkspaceEditApplicationResult>;
  closeAllTabs(paneId: EditorPaneId): void;
  closeOtherTabs(paneId: EditorPaneId, tabId: EditorTabId): void;
  closeTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  closeActiveTab(): Promise<void>;
  closeTabsToRight(paneId: EditorPaneId, tabId: EditorTabId): void;
  copyTabPath(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  dropExternalPayload(input: DropExternalEditorPayloadInput): void;
  hasActiveTab(): boolean;
  moveActiveTabToPane(direction: EditorGroupSpatialDirection): void;
  moveTabToPane(
    sourcePaneId: EditorPaneId,
    targetPaneId: EditorPaneId,
    tabId: EditorTabId,
    targetIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  openFile(workspaceId: WorkspaceId, path: string): Promise<void>;
  openFileFromTreeDrop(paneId: EditorPaneId, workspaceId: WorkspaceId, path: string): void;
  openFileToSide(workspaceId: WorkspaceId, path: string): void;
  reorderTab(
    paneId: EditorPaneId,
    oldIndex: number,
    newIndex: number,
    workspaceId?: WorkspaceId | null,
  ): void;
  revealTabInFinder(tab: EditorTab): void;
  saveTab(tabId: EditorTabId): void;
  splitDown(): void;
  splitRight(): void;
  splitToDirection(direction: EditorGroupSplitDirection): void;
  splitTabRight(sourcePaneId: EditorPaneId, tabId: EditorTabId, workspaceId?: WorkspaceId | null): void;
  updateTabContent(tabId: EditorTabId, content: string): void;
}

export function useEditorBindings({
  activeWorkspaceId,
  documentsService,
  filesService,
  gitService,
  groupsService,
  openWorkspaces,
  workspaceService,
}: UseEditorBindingsInput): EditorBindings {
  const editorModel = useStore(groupsService, (state) => state.model);
  const editorGroups = useStore(groupsService, (state) => state.groups);
  const editorActiveGroupId = useStore(groupsService, (state) => state.activeGroupId);
  const editorLayoutSnapshot = useStore(groupsService, (state) => state.layoutSnapshot);
  const editorDocumentsById = useStore(documentsService, (state) => state.documentsById);
  const panes = useMemo(
    () => editorPanesFromGroups(editorGroups, editorDocumentsById),
    [editorGroups, editorDocumentsById],
  );
  const activePaneId = useMemo(
    () => resolveActiveEditorPaneId(panes, editorActiveGroupId),
    [panes, editorActiveGroupId],
  );

  const refreshFileTree = useCallback(async (workspaceId?: WorkspaceId | null) => {
    await refreshEditorFileTreeAndGitBadges(filesService, gitService, workspaceId);
  }, [filesService, gitService]);

  const openFile = useCallback(async (workspaceId: WorkspaceId, path: string) => {
    await openEditorFileInServices({
      documentsService,
      filesService,
      groupsService,
      workspaceService,
      workspaceId,
      path,
    });
  }, [documentsService, filesService, groupsService, workspaceService]);

  const activatePane = useCallback((paneId: EditorPaneId) => {
    groupsService.getState().activateGroup(paneId);
  }, [groupsService]);

  const activateTab = useCallback((paneId: EditorPaneId, tabId: EditorTabId) => {
    groupsService.getState().activateTab(paneId, tabId);
    const document = documentsService.getState().getDocument(tabId);
    if (document?.kind === "file") {
      filesService.getState().selectPath(document.path);
    }
    workspaceService.getState().setCenterMode("editor-max");
  }, [documentsService, filesService, groupsService, workspaceService]);

  const splitToDirection = useCallback((direction: EditorGroupSplitDirection) => {
    splitEditorPaneInGroups(groupsService, direction);
    workspaceService.getState().setCenterMode("editor-max");
  }, [groupsService, workspaceService]);

  const splitRight = useCallback(() => {
    splitToDirection("right");
  }, [splitToDirection]);

  const splitDown = useCallback(() => {
    splitToDirection("bottom");
  }, [splitToDirection]);

  const dropExternalPayload = useCallback((input: DropExternalEditorPayloadInput) => {
    void runEditorMutation(async () => {
      await dropExternalEditorPayloadInServices({
        documentsService,
        filesService,
        groupsService,
        openWorkspaces,
        workspaceService,
        input,
      });
    });
  }, [documentsService, filesService, groupsService, openWorkspaces, workspaceService]);

  const moveActiveTabToPane = useCallback((direction: EditorGroupSpatialDirection) => {
    moveActiveEditorTabToAdjacentGroup(groupsService, direction);
    workspaceService.getState().setCenterMode("editor-max");
  }, [groupsService, workspaceService]);

  const reorderTab = useCallback((
    paneId: EditorPaneId,
    oldIndex: number,
    newIndex: number,
    workspaceId?: WorkspaceId | null,
  ) => {
    reorderEditorTabInGroupScope(groupsService, paneId, oldIndex, newIndex, workspaceId);
    workspaceService.getState().setCenterMode("editor-max");
  }, [groupsService, workspaceService]);

  const moveTabToPane = useCallback((
    sourcePaneId: EditorPaneId,
    targetPaneId: EditorPaneId,
    tabId: EditorTabId,
    targetIndex: number,
    workspaceId?: WorkspaceId | null,
  ) => {
    moveEditorTabToGroupScope(groupsService, sourcePaneId, targetPaneId, tabId, targetIndex, workspaceId);
    workspaceService.getState().setCenterMode("editor-max");
  }, [groupsService, workspaceService]);

  const splitTabRight = useCallback((
    sourcePaneId: EditorPaneId,
    tabId: EditorTabId,
    workspaceId?: WorkspaceId | null,
  ) => {
    splitEditorPaneRightAndMoveTabInGroups(groupsService, sourcePaneId, tabId, workspaceId);
    workspaceService.getState().setCenterMode("editor-max");
  }, [groupsService, workspaceService]);

  const updateTabContent = useCallback((tabId: EditorTabId, content: string) => {
    void runEditorMutation(() => documentsService.getState().updateDocumentContent(tabId, content));
  }, [documentsService]);

  const saveTab = useCallback((tabId: EditorTabId) => {
    void runEditorMutation(async () => {
      const document = documentsService.getState().getDocument(tabId);
      await documentsService.getState().saveDocument(tabId);
      if (document?.kind === "file") {
        await refreshFileTree(document.workspaceId);
      }
    });
  }, [documentsService, refreshFileTree]);

  const closeTab = useCallback((paneId: EditorPaneId, tabId: EditorTabId) => {
    void runEditorMutation(() => closeEditorTabInServices(groupsService, documentsService, paneId, tabId));
  }, [documentsService, groupsService]);

  const closeActiveTab = useCallback(async () => {
    await closeActiveEditorTabInServices(groupsService, documentsService);
  }, [documentsService, groupsService]);

  const hasActiveTab = useCallback(() => hasActiveEditorTab(groupsService), [groupsService]);

  const applyWorkspaceEdit = useCallback(async (
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult> => {
    const result = await documentsService.getState().applyWorkspaceEdit(workspaceId, edit);
    openAppliedWorkspaceEditDocumentsInGroups(
      groupsService,
      documentsService,
      workspaceId,
      result.appliedPaths,
    );
    return result;
  }, [documentsService, groupsService]);

  const openFileToSide = useCallback((workspaceId: WorkspaceId, path: string) => {
    void runEditorMutation(async () => {
      splitEditorPaneRightInGroups(groupsService);
      await openEditorFileInServices({
        documentsService,
        filesService,
        groupsService,
        workspaceService,
        workspaceId,
        path,
      });
    });
  }, [documentsService, filesService, groupsService, workspaceService]);

  const openFileFromTreeDrop = useCallback((paneId: EditorPaneId, workspaceId: WorkspaceId, path: string) => {
    dropExternalPayload({
      payload: {
        type: "workspace-file",
        workspaceId,
        path,
        kind: "file",
      },
      targetGroupId: paneId,
      edge: "center",
    });
  }, [dropExternalPayload]);

  const closeOtherTabs = useCallback((paneId: EditorPaneId, tabId: EditorTabId) => {
    const targetTab = panes
      .find((pane) => pane.id === paneId)
      ?.tabs.find((tab) => tab.id === tabId);
    if (!targetTab) {
      return;
    }
    void closeEditorTabsMatching(
      groupsService,
      documentsService,
      panes,
      paneId,
      (tab) => tab.workspaceId === targetTab.workspaceId && tab.id !== tabId,
    );
  }, [documentsService, groupsService, panes]);

  const closeTabsToRight = useCallback((paneId: EditorPaneId, tabId: EditorTabId) => {
    void closeEditorTabsToRightOf(groupsService, documentsService, panes, paneId, tabId);
  }, [documentsService, groupsService, panes]);

  const closeAllTabs = useCallback((paneId: EditorPaneId) => {
    void closeEditorTabsMatching(
      groupsService,
      documentsService,
      panes,
      paneId,
      (tab) => !activeWorkspaceId || tab.workspaceId === activeWorkspaceId,
    );
  }, [activeWorkspaceId, documentsService, groupsService, panes]);

  const copyTabPath = useCallback((tab: EditorTab, pathKind: "absolute" | "relative") => {
    void runFileActionMutation(() =>
      window.nexusFileActions.invoke({
        type: "file-actions/copy-path",
        workspaceId: tab.workspaceId,
        path: tab.path,
        pathKind,
      }),
    );
  }, []);

  const revealTabInFinder = useCallback((tab: EditorTab) => {
    void runFileActionMutation(() =>
      window.nexusFileActions.invoke({
        type: "file-actions/reveal-in-finder",
        workspaceId: tab.workspaceId,
        path: tab.path,
      }),
    );
  }, []);

  return useMemo(() => ({
    activeGroupId: editorActiveGroupId,
    activePaneId,
    groups: editorGroups,
    layoutSnapshot: editorLayoutSnapshot,
    model: editorModel,
    panes,
    activatePane,
    activateTab,
    applyWorkspaceEdit,
    closeAllTabs,
    closeOtherTabs,
    closeTab,
    closeActiveTab,
    closeTabsToRight,
    copyTabPath,
    dropExternalPayload,
    hasActiveTab,
    moveActiveTabToPane,
    moveTabToPane,
    openFile,
    openFileFromTreeDrop,
    openFileToSide,
    reorderTab,
    revealTabInFinder,
    saveTab,
    splitDown,
    splitRight,
    splitToDirection,
    splitTabRight,
    updateTabContent,
  }), [
    activePaneId,
    editorActiveGroupId,
    editorGroups,
    editorLayoutSnapshot,
    editorModel,
    panes,
    activatePane,
    activateTab,
    applyWorkspaceEdit,
    closeAllTabs,
    closeOtherTabs,
    closeTab,
    closeActiveTab,
    closeTabsToRight,
    copyTabPath,
    dropExternalPayload,
    hasActiveTab,
    moveActiveTabToPane,
    moveTabToPane,
    openFile,
    openFileFromTreeDrop,
    openFileToSide,
    reorderTab,
    revealTabInFinder,
    saveTab,
    splitDown,
    splitRight,
    splitToDirection,
    splitTabRight,
    updateTabContent,
  ]);
}

export async function dropExternalEditorPayloadInServices({
  documentsService,
  filesService,
  groupsService,
  openWorkspaces,
  workspaceService,
  input,
}: {
  documentsService: EditorDocumentsServiceStore;
  filesService: FilesServiceStore;
  groupsService: EditorGroupsServiceStore;
  openWorkspaces?: readonly OpenSessionWorkspace[];
  workspaceService: WorkspaceServiceStore;
  input: DropExternalEditorPayloadInput;
}): Promise<EditorGroupId | null> {
  const payload = normalizeExternalEditorDropPayloadForOpenWorkspaces(
    input.payload,
    openWorkspaces ?? workspaceService.getState().getOpenWorkspaces(),
  );
  const workspaceFiles = workspaceFileDropItemsFromPayload(payload);
  for (const item of workspaceFiles) {
    await documentsService.getState().openDocument(item.workspaceId, item.path);
  }

  const droppedGroupId = groupsService.getState().dropExternalPayload({
    ...input,
    payload,
  });
  if (!droppedGroupId) {
    return null;
  }

  const selectedFile = workspaceFiles.at(-1);
  if (selectedFile) {
    filesService.getState().selectPath(selectedFile.path);
  }
  workspaceService.getState().setCenterMode("editor-max");
  return droppedGroupId;
}

function normalizeExternalEditorDropPayloadForOpenWorkspaces(
  payload: ExternalEditorDropPayload,
  openWorkspaces: readonly OpenSessionWorkspace[],
): ExternalEditorDropPayload {
  if (payload.type !== "os-file" || payload.files.length === 0) {
    return payload;
  }

  const resolvedItems = payload.files.map((file, index) => ({
    file,
    absolutePath: resolveAbsolutePathForOsFile(file, payload.resolvedPaths?.[index]),
  }));
  if (resolvedItems.some((item) => !item.absolutePath)) {
    return payload;
  }

  const workspaceItems = resolvedItems
    .map((item) => {
      const resolvedWorkspacePath = resolveWorkspacePathForAbsoluteFile(
        item.absolutePath!,
        openWorkspaces,
      );
      return resolvedWorkspacePath
        ? {
            workspaceId: resolvedWorkspacePath.workspaceId,
            path: resolvedWorkspacePath.path,
            kind: "file" as const,
          }
        : null;
    });

  if (workspaceItems.some((item) => item === null)) {
    return payload;
  }

  const items = workspaceItems.filter((item): item is NonNullable<typeof item> => item !== null);
  const workspaceId = items[0]?.workspaceId ?? null;
  if (!workspaceId || items.some((item) => item.workspaceId !== workspaceId)) {
    return payload;
  }

  if (items.length === 1) {
    const item = items[0]!;
    return {
      type: "workspace-file",
      workspaceId,
      path: item.path,
      kind: "file",
    };
  }

  return {
    type: "workspace-file-multi",
    workspaceId,
    items: items.map(({ path, kind }) => ({ path, kind })),
  };
}

function workspaceFileDropItemsFromPayload(
  payload: ExternalEditorDropPayload,
): { workspaceId: WorkspaceId; path: string }[] {
  switch (payload.type) {
    case "workspace-file":
      return payload.kind === "file"
        ? [{ workspaceId: payload.workspaceId, path: payload.path }]
        : [];
    case "workspace-file-multi":
      return payload.items
        .filter((item) => item.kind === "file")
        .map((item) => ({ workspaceId: payload.workspaceId, path: item.path }));
    case "os-file":
    case "terminal-tab":
      return [];
  }
}

function resolveAbsolutePathForOsFile(file: File, resolvedPath?: string): string | null {
  if (typeof resolvedPath === "string" && isAbsoluteFilePath(resolvedPath)) {
    return resolvedPath;
  }

  try {
    const preloadPath = globalThis.window?.nexusFileActions?.getPathForFile(file);
    if (typeof preloadPath === "string" && isAbsoluteFilePath(preloadPath)) {
      return preloadPath;
    }
  } catch {
    // Ignore preload path resolution failures and fall back to Electron's
    // non-standard File.path shape below.
  }

  const electronPath = (file as File & { path?: unknown }).path;
  if (typeof electronPath === "string" && isAbsoluteFilePath(electronPath)) {
    return electronPath;
  }

  return null;
}

function resolveWorkspacePathForAbsoluteFile(
  absolutePath: string,
  openWorkspaces: readonly OpenSessionWorkspace[],
): { workspaceId: WorkspaceId; path: string } | null {
  return openWorkspaces
    .map((workspace) => ({
      workspaceId: workspace.id,
      root: workspace.absolutePath,
      path: relativeWorkspacePath(absolutePath, workspace.absolutePath),
    }))
    .filter((candidate): candidate is { workspaceId: WorkspaceId; root: string; path: string } =>
      candidate.path !== null && candidate.path.length > 0
    )
    .sort((left, right) => normalizePathSeparators(right.root).length - normalizePathSeparators(left.root).length)[0] ?? null;
}

function relativeWorkspacePath(absolutePath: string, workspaceRoot: string): string | null {
  const normalizedAbsolutePath = trimTrailingPathSeparators(normalizePathSeparators(absolutePath));
  const normalizedWorkspaceRoot = trimTrailingPathSeparators(normalizePathSeparators(workspaceRoot));
  const compareAsLowerCase = shouldComparePathCaseInsensitively(normalizedAbsolutePath, normalizedWorkspaceRoot);
  const comparableAbsolutePath = compareAsLowerCase ? normalizedAbsolutePath.toLowerCase() : normalizedAbsolutePath;
  const comparableWorkspaceRoot = compareAsLowerCase ? normalizedWorkspaceRoot.toLowerCase() : normalizedWorkspaceRoot;

  if (!comparableAbsolutePath.startsWith(`${comparableWorkspaceRoot}/`)) {
    return null;
  }

  return normalizedAbsolutePath.slice(normalizedWorkspaceRoot.length + 1);
}

function isAbsoluteFilePath(filePath: string): boolean {
  const normalizedPath = normalizePathSeparators(filePath);
  return normalizedPath.startsWith("/") ||
    normalizedPath.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalizedPath);
}

function normalizePathSeparators(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function trimTrailingPathSeparators(filePath: string): string {
  return filePath.replace(/\/+$/g, "");
}

function shouldComparePathCaseInsensitively(
  absolutePath: string,
  workspaceRoot: string,
): boolean {
  if (/^[A-Za-z]:\//.test(absolutePath) || /^[A-Za-z]:\//.test(workspaceRoot)) {
    return true;
  }

  const platform = globalThis.window?.nexusEnvironment?.platform ?? null;
  return platform === "win32" || platform === "cygwin";
}

export async function openEditorFileInServices({
  documentsService,
  filesService,
  groupsService,
  workspaceService,
  workspaceId,
  path,
  targetGroupId,
}: {
  documentsService: EditorDocumentsServiceStore;
  filesService: FilesServiceStore;
  groupsService: EditorGroupsServiceStore;
  workspaceService: WorkspaceServiceStore;
  workspaceId: WorkspaceId;
  path: string;
  targetGroupId?: EditorGroupId;
}): Promise<void> {
  const document = await documentsService.getState().openDocument(workspaceId, path);
  openDocumentInEditorGroup(groupsService, document, targetGroupId);
  filesService.getState().selectPath(document.path);
  workspaceService.getState().setCenterMode("editor-max");
}

export async function openEditorDiffInServices(
  documentsService: EditorDocumentsServiceStore,
  groupsService: EditorGroupsServiceStore,
  workspaceService: WorkspaceServiceStore,
  left: OpenDiffTabSide,
  right: OpenDiffTabSide,
  options?: OpenDiffTabOptions,
): Promise<void> {
  const document = await documentsService.getState().openDiff(left, right, options);
  openDocumentInEditorGroup(groupsService, document);
  workspaceService.getState().setCenterMode("editor-max");
}

export function splitEditorPaneRightInGroups(groupsService: EditorGroupsServiceStore): void {
  splitEditorPaneInGroups(groupsService, "right");
}

export function splitEditorPaneDownInGroups(groupsService: EditorGroupsServiceStore): void {
  splitEditorPaneInGroups(groupsService, "bottom");
}

function splitEditorPaneInGroups(
  groupsService: EditorGroupsServiceStore,
  direction: EditorGroupSplitDirection,
): void {
  const state = groupsService.getState();
  const currentGroups = collapseEmptyGroups(state.groups);

  if (currentGroups.length !== state.groups.length) {
    state.setGroups(currentGroups, state.activeGroupId ?? currentGroups[0]?.id ?? null);
  }

  if (currentGroups.length >= MAX_EDITOR_PANE_COUNT) {
    return;
  }

  const activeGroupId = groupsService.getState().activeGroupId ?? currentGroups[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
  const activeGroup = currentGroups.find((group) => group.id === activeGroupId) ?? currentGroups[0] ?? null;
  const tabId = activeGroup?.activeTabId ?? activeGroup?.tabs.at(-1)?.id ?? null;

  if (!activeGroup || !tabId) {
    return;
  }

  const splitGroupId = groupsService.getState().splitGroup({
    sourceGroupId: activeGroup.id,
    tabId,
    direction,
    targetGroupId: uniqueEditorGroupId(SECONDARY_EDITOR_PANE_ID, currentGroups),
    activate: false,
  });

  if (splitGroupId) {
    groupsService.getState().activateGroup(activeGroup.id);
  }
}

export function removeEditorTabsForDeletedPath(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  workspaceId: WorkspaceId,
  deletedPath: string,
  kind: WorkspaceFileKind,
): void {
  const documents = documentsService.getState().documentsById;
  const shouldRemove = (document: EditorDocument): boolean =>
    document.workspaceId === workspaceId &&
    (kind === "directory" ? documentTouchesWorkspacePath(document, workspaceId, deletedPath) : documentPathMatches(document, workspaceId, deletedPath));
  const groups = groupsService.getState().groups.map((group) => ({
    ...group,
    tabs: group.tabs.filter((tab) => {
      const document = documents[tab.id];
      return !document || !shouldRemove(document);
    }),
    activeTabId: group.activeTabId && documents[group.activeTabId] && shouldRemove(documents[group.activeTabId])
      ? null
      : group.activeTabId,
  }));
  groupsService.getState().setGroups(collapseEmptyGroups(groups), groupsService.getState().activeGroupId);
  documentsService.setState((state) => {
    const documentsById = { ...state.documentsById };
    for (const [documentId, document] of Object.entries(state.documentsById)) {
      if (shouldRemove(document)) {
        delete documentsById[documentId];
      }
    }
    return { documentsById };
  });
}

export function renameEditorDocumentsAndTabs(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  workspaceId: WorkspaceId,
  oldPath: string,
  newPath: string,
): void {
  const idMap = new Map<EditorTabId, EditorDocument>();
  documentsService.setState((state) => {
    const documentsById: Record<string, EditorDocument> = {};
    for (const document of Object.values(state.documentsById)) {
      const renamedDocument = renameDocumentPath(document, workspaceId, oldPath, newPath);
      documentsById[renamedDocument.id] = renamedDocument;
      if (renamedDocument.id !== document.id) {
        idMap.set(document.id, renamedDocument);
      }
    }
    return {
      documentsById,
      activeDocumentId: state.activeDocumentId ? idMap.get(state.activeDocumentId)?.id ?? state.activeDocumentId : null,
    };
  });

  if (idMap.size === 0) {
    return;
  }

  const groups = groupsService.getState().groups.map((group) => ({
    ...group,
    tabs: group.tabs.map((tab) => {
      const renamedDocument = idMap.get(tab.id);
      return renamedDocument ? editorGroupTabForDocument(renamedDocument) : tab;
    }),
    activeTabId: group.activeTabId ? idMap.get(group.activeTabId)?.id ?? group.activeTabId : null,
  }));
  groupsService.getState().setGroups(groups, groupsService.getState().activeGroupId);
}

export async function runEditorMutation(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("Editor: failed to apply editor mutation.", error);
  }
}

export async function runFileActionMutation(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error("File action: failed to apply context-menu action.", error);
  }
}

function editorPanesFromGroups(
  groups: readonly EditorGroup[],
  documentsById: Record<string, EditorDocument>,
): EditorPaneState[] {
  const sourceGroups = groups.length > 0
    ? groups
    : [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [], activeTabId: null }];

  return sourceGroups.map((group) => {
    const tabs = group.tabs
      .map((tab) => documentsById[tab.id] ?? null)
      .filter((tab): tab is EditorTab => tab !== null);
    const activeTabId = group.activeTabId && tabs.some((tab) => tab.id === group.activeTabId)
      ? group.activeTabId
      : tabs[0]?.id ?? null;

    return {
      id: group.id,
      tabs,
      activeTabId,
    };
  });
}

function resolveActiveEditorPaneId(
  panes: readonly EditorPaneState[],
  activeGroupId: EditorGroupId | null,
): EditorPaneId {
  if (activeGroupId && panes.some((pane) => pane.id === activeGroupId)) {
    return activeGroupId;
  }

  return panes[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
}

function openDocumentInEditorGroup(
  groupsService: EditorGroupsServiceStore,
  document: EditorDocument,
  targetGroupId?: EditorGroupId,
): void {
  const state = groupsService.getState();
  const groupId = targetGroupId ?? state.activeGroupId ?? state.groups[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
  groupsService.getState().openTab(groupId, editorGroupTabForDocument(document), { activate: true });
  groupsService.getState().activateGroup(groupId);
}

function editorGroupTabForDocument(document: EditorDocument): EditorGroupTab {
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    workspaceId: document.workspaceId,
    resourcePath: document.path,
  };
}

function moveActiveEditorTabToAdjacentGroup(
  groupsService: EditorGroupsServiceStore,
  direction: EditorGroupSpatialDirection,
): void {
  const state = groupsService.getState();
  const sourceGroup = state.groups.find((group) => group.id === state.activeGroupId) ?? null;
  const targetGroupId = sourceGroup ? state.findSpatialNeighbor(sourceGroup.id, direction) : null;
  const targetGroup = targetGroupId
    ? state.groups.find((group) => group.id === targetGroupId)
    : null;
  const tabId = sourceGroup?.activeTabId ?? null;
  if (!sourceGroup || !targetGroup || !tabId) {
    return;
  }

  groupsService.getState().moveTab({
    sourceGroupId: sourceGroup.id,
    targetGroupId: targetGroup.id,
    tabId,
    activate: true,
  });
  collapseEmptyEditorGroups(groupsService, targetGroup.id);
}

function reorderEditorTabInGroupScope(
  groupsService: EditorGroupsServiceStore,
  groupId: EditorGroupId,
  oldIndex: number,
  newIndex: number,
  workspaceId?: WorkspaceId | null,
): void {
  const state = groupsService.getState();
  const groups = state.groups.map((group) => {
    if (group.id !== groupId) {
      return group;
    }

    const scopedTabs = tabsForWorkspaceScope(group.tabs, workspaceId);
    const sourceTab = scopedTabs[oldIndex];
    if (!sourceTab) {
      return group;
    }

    const reorderedTabs = arrayMove(scopedTabs, oldIndex, clampTabIndex(newIndex, scopedTabs.length - 1));
    return {
      ...group,
      tabs: replaceTabsInWorkspaceScope(group.tabs, workspaceId, reorderedTabs),
      activeTabId: sourceTab.id,
    };
  });
  groupsService.getState().setGroups(groups, groupId);
}

function moveEditorTabToGroupScope(
  groupsService: EditorGroupsServiceStore,
  sourceGroupId: EditorGroupId,
  targetGroupId: EditorGroupId,
  tabId: EditorTabId,
  targetIndex: number,
  workspaceId?: WorkspaceId | null,
): void {
  const state = groupsService.getState();
  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId);
  const targetGroup = state.groups.find((group) => group.id === targetGroupId);
  const tab = sourceGroup?.tabs.find((candidate) => candidate.id === tabId) ?? null;
  const sourceTabIndex = sourceGroup?.tabs.findIndex((candidate) => candidate.id === tabId) ?? -1;
  if (!sourceGroup || !targetGroup || !tab) {
    return;
  }

  if (sourceGroupId === targetGroupId) {
    const scopedTabs = tabsForWorkspaceScope(sourceGroup.tabs, workspaceId);
    const oldIndex = scopedTabs.findIndex((candidate) => candidate.id === tabId);
    if (oldIndex >= 0) {
      reorderEditorTabInGroupScope(groupsService, sourceGroupId, oldIndex, targetIndex, workspaceId);
    }
    return;
  }

  const sourceTabs = sourceGroup.tabs.filter((candidate) => candidate.id !== tabId);
  const targetTabs = insertTabAtWorkspaceScopedIndex(targetGroup.tabs, tab, targetIndex, workspaceId ?? tab.workspaceId);
  const groups = state.groups.map((group) => {
    if (group.id === sourceGroupId) {
      return {
        ...group,
        tabs: sourceTabs,
        activeTabId: group.activeTabId === tabId
          ? sourceTabs.at(Math.max(0, sourceTabIndex - 1))?.id ?? sourceTabs[0]?.id ?? null
          : group.activeTabId,
      };
    }
    if (group.id === targetGroupId) {
      return {
        ...group,
        tabs: targetTabs,
        activeTabId: tabId,
      };
    }
    return group;
  });
  groupsService.getState().setGroups(groups, targetGroupId);
  collapseEmptyEditorGroups(groupsService, targetGroupId);
}

function splitEditorPaneRightAndMoveTabInGroups(
  groupsService: EditorGroupsServiceStore,
  sourceGroupId: EditorGroupId,
  tabId: EditorTabId,
  _workspaceId?: WorkspaceId | null,
): void {
  const state = groupsService.getState();
  if (state.groups.length !== 1 || state.groups.length >= MAX_EDITOR_PANE_COUNT) {
    return;
  }

  const sourceGroup = state.groups.find((group) => group.id === sourceGroupId);
  const tab = sourceGroup?.tabs.find((candidate) => candidate.id === tabId) ?? null;
  if (!sourceGroup || !tab) {
    return;
  }

  const sourceTabs = sourceGroup.tabs.filter((candidate) => candidate.id !== tabId);
  const newGroupId = uniqueEditorGroupId(SECONDARY_EDITOR_PANE_ID, state.groups);
  groupsService.getState().setGroups([
    {
      ...sourceGroup,
      tabs: sourceTabs,
      activeTabId: sourceGroup.activeTabId === tabId ? sourceTabs[0]?.id ?? null : sourceGroup.activeTabId,
    },
    {
      id: newGroupId,
      tabs: [tab],
      activeTabId: tab.id,
    },
  ], newGroupId);
}

async function closeActiveEditorTabInServices(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
): Promise<void> {
  const state = groupsService.getState();
  const activeGroup = state.groups.find((group) => group.id === state.activeGroupId) ?? state.groups[0] ?? null;
  if (!activeGroup?.activeTabId) {
    return;
  }

  await closeEditorTabInServices(groupsService, documentsService, activeGroup.id, activeGroup.activeTabId);
}

function hasActiveEditorTab(groupsService: EditorGroupsServiceStore): boolean {
  const state = groupsService.getState();
  const activeGroup = state.groups.find((group) => group.id === state.activeGroupId) ?? state.groups[0] ?? null;
  return Boolean(activeGroup?.activeTabId);
}

async function closeEditorTabInServices(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  groupId: EditorGroupId,
  tabId: EditorTabId,
): Promise<void> {
  groupsService.getState().closeTab(groupId, tabId);
  collapseEmptyEditorGroups(groupsService);

  if (!groupTabExists(groupsService.getState().groups, tabId)) {
    await documentsService.getState().closeDocument(tabId);
  }
}

function collapseEmptyEditorGroups(
  groupsService: EditorGroupsServiceStore,
  preferredActiveGroupId?: EditorGroupId | null,
): void {
  const state = groupsService.getState();
  const groups = collapseEmptyGroups(state.groups);
  if (groups.length === state.groups.length) {
    return;
  }
  groupsService.getState().setGroups(groups, preferredActiveGroupId ?? state.activeGroupId ?? groups[0]?.id ?? null);
}

function collapseEmptyGroups(groups: readonly EditorGroup[]): EditorGroup[] {
  if (groups.length <= 1) {
    return groups.map((group) => ({ ...group, tabs: [...group.tabs] }));
  }

  const nonEmptyGroups = groups.filter((group) => group.tabs.length > 0);
  return nonEmptyGroups.length > 0
    ? nonEmptyGroups.map((group) => ({ ...group, tabs: [...group.tabs] }))
    : [{ id: DEFAULT_EDITOR_PANE_ID, tabs: [], activeTabId: null }];
}

function groupTabExists(groups: readonly EditorGroup[], tabId: EditorTabId): boolean {
  return groups.some((group) => group.tabs.some((tab) => tab.id === tabId));
}

function openAppliedWorkspaceEditDocumentsInGroups(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  workspaceId: WorkspaceId,
  paths: readonly string[],
): void {
  const state = groupsService.getState();
  const groupId = state.activeGroupId ?? state.groups[0]?.id ?? DEFAULT_EDITOR_PANE_ID;
  for (const path of paths) {
    const document = documentsService.getState().getDocumentByWorkspacePath(workspaceId, path);
    if (document) {
      groupsService.getState().openTab(groupId, editorGroupTabForDocument(document), { activate: false });
    }
  }
}

function tabsForWorkspaceScope(
  tabs: readonly EditorGroupTab[],
  workspaceId: WorkspaceId | null | undefined,
): EditorGroupTab[] {
  return workspaceId ? tabs.filter((tab) => tab.workspaceId === workspaceId) : [...tabs];
}

function replaceTabsInWorkspaceScope(
  tabs: readonly EditorGroupTab[],
  workspaceId: WorkspaceId | null | undefined,
  replacements: readonly EditorGroupTab[],
): EditorGroupTab[] {
  if (!workspaceId) {
    return [...replacements];
  }

  let scopedIndex = 0;
  return tabs.map((tab) => {
    if (tab.workspaceId !== workspaceId) {
      return tab;
    }

    const replacement = replacements[scopedIndex] ?? tab;
    scopedIndex += 1;
    return replacement;
  });
}

function insertTabAtWorkspaceScopedIndex(
  tabs: readonly EditorGroupTab[],
  tab: EditorGroupTab,
  targetIndex: number,
  workspaceId: WorkspaceId | null | undefined,
): EditorGroupTab[] {
  const nextTabs = tabs.filter((candidate) => candidate.id !== tab.id);
  if (!workspaceId) {
    nextTabs.splice(clampTabIndex(targetIndex, nextTabs.length), 0, tab);
    return nextTabs;
  }

  const scopedPositions = nextTabs
    .map((candidate, index) => candidate.workspaceId === workspaceId ? index : -1)
    .filter((index) => index >= 0);
  const clampedTargetIndex = clampTabIndex(targetIndex, scopedPositions.length);
  const fullInsertIndex = clampedTargetIndex >= scopedPositions.length
    ? (scopedPositions.at(-1) ?? nextTabs.length - 1) + 1
    : scopedPositions[clampedTargetIndex]!;
  nextTabs.splice(fullInsertIndex, 0, tab);
  return nextTabs;
}

function arrayMove<TValue>(values: readonly TValue[], oldIndex: number, newIndex: number): TValue[] {
  const nextValues = [...values];
  const [value] = nextValues.splice(oldIndex, 1);
  if (value === undefined) {
    return nextValues;
  }
  nextValues.splice(newIndex, 0, value);
  return nextValues;
}

function clampTabIndex(index: number, maxIndex: number): number {
  if (!Number.isFinite(index)) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(index), 0), Math.max(maxIndex, 0));
}

function uniqueEditorGroupId(preferredGroupId: EditorGroupId, groups: readonly EditorGroup[]): EditorGroupId {
  let candidate = preferredGroupId;
  let suffix = 2;
  while (groups.some((group) => group.id === candidate)) {
    candidate = `${preferredGroupId}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function renameDocumentPath(
  document: EditorDocument,
  workspaceId: WorkspaceId,
  oldPath: string,
  newPath: string,
): EditorDocument {
  if (document.kind === "diff" && document.diff && documentTouchesWorkspacePath(document, workspaceId, oldPath)) {
    const left = renameDiffSidePath(document.diff.left, workspaceId, oldPath, newPath);
    const right = renameDiffSidePath(document.diff.right, workspaceId, oldPath, newPath);
    return {
      ...document,
      id: diffTabIdFor(document.workspaceId, left, right, document.diff.source),
      path: `${left.path} ↔ ${right.path}`,
      title: `${left.title} ↔ ${right.title}`,
      diff: {
        ...document.diff,
        left,
        right,
      },
    };
  }

  if (document.workspaceId !== workspaceId || !isPathOrDescendant(document.path, oldPath)) {
    return document;
  }

  const nextPath = rewritePathPrefix(document.path, oldPath, newPath);
  const nextLanguage = detectLspLanguage(nextPath);
  return {
    ...document,
    id: tabIdFor(workspaceId, nextPath),
    path: nextPath,
    title: titleForPath(nextPath),
    language: nextLanguage,
    monacoLanguage: monacoLanguageIdForPath(nextPath, nextLanguage),
    diagnostics: document.language === nextLanguage
      ? document.diagnostics.map((diagnostic) => ({
          ...diagnostic,
          path: rewritePathPrefix(diagnostic.path, oldPath, newPath),
        }))
      : [],
  };
}

function renameDiffSidePath(
  side: EditorDiffSide,
  workspaceId: WorkspaceId,
  oldPath: string,
  newPath: string,
): EditorDiffSide {
  if (side.workspaceId !== workspaceId || !isPathOrDescendant(side.path, oldPath)) {
    return side;
  }

  const nextPath = rewritePathPrefix(side.path, oldPath, newPath);
  const nextLanguage = detectLspLanguage(nextPath);
  return {
    ...side,
    path: nextPath,
    title: titleForPath(nextPath),
    language: nextLanguage,
    monacoLanguage: monacoLanguageIdForPath(nextPath, nextLanguage),
  };
}

function documentPathMatches(document: EditorDocument, workspaceId: WorkspaceId, path: string): boolean {
  if (document.workspaceId !== workspaceId) {
    return false;
  }

  if (document.kind === "diff" && document.diff) {
    return document.diff.left.path === path || document.diff.right.path === path;
  }

  return document.path === path;
}

function documentTouchesWorkspacePath(document: EditorDocument, workspaceId: WorkspaceId, path: string): boolean {
  if (document.workspaceId !== workspaceId) {
    return false;
  }

  if (document.kind === "diff" && document.diff) {
    return (
      (document.diff.left.workspaceId === workspaceId && isPathOrDescendant(document.diff.left.path, path)) ||
      (document.diff.right.workspaceId === workspaceId && isPathOrDescendant(document.diff.right.path, path))
    );
  }

  return isPathOrDescendant(document.path, path);
}

function isPathOrDescendant(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function rewritePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) {
    return newPath;
  }
  if (!path.startsWith(`${oldPath}/`)) {
    return path;
  }
  return `${newPath}${path.slice(oldPath.length)}`;
}

async function closeEditorTabsMatching(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  panes: readonly EditorPaneState[],
  paneId: EditorPaneId,
  predicate: (tab: EditorTab, index: number) => boolean,
): Promise<void> {
  const pane = panes.find((candidate) => candidate.id === paneId);
  const tabIds = pane?.tabs
    .map((tab, index) => (predicate(tab, index) ? tab.id : null))
    .filter((tabId): tabId is EditorTabId => tabId !== null) ?? [];

  for (const tabId of tabIds) {
    await runEditorMutation(() => closeEditorTabInServices(groupsService, documentsService, paneId, tabId));
  }
}

async function closeEditorTabsToRightOf(
  groupsService: EditorGroupsServiceStore,
  documentsService: EditorDocumentsServiceStore,
  panes: readonly EditorPaneState[],
  paneId: EditorPaneId,
  tabId: EditorTabId,
): Promise<void> {
  const pane = panes.find((candidate) => candidate.id === paneId);
  const tabIndex = pane?.tabs.findIndex((tab) => tab.id === tabId) ?? -1;
  if (!pane || tabIndex < 0) {
    return;
  }
  const targetWorkspaceId = pane.tabs[tabIndex]?.workspaceId ?? null;

  await closeEditorTabsMatching(
    groupsService,
    documentsService,
    panes,
    paneId,
    (tab, index) => index > tabIndex && tab.workspaceId === targetWorkspaceId,
  );
}
