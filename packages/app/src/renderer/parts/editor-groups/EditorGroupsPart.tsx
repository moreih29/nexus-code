import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";

import { Actions, Layout, TabNode, type Action, type Model, type NodeMouseEvent } from "flexlayout-react";

import type {
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import { EditorPane } from "../../components/EditorPane";
import {
  readExternalEditorDropPayload,
  writeTerminalTabDragDataTransfer,
  type TerminalTabDragData,
} from "../../components/file-tree-dnd/drag-and-drop";
import type {
  DropExternalEditorPayloadInput,
  EditorGroupsServiceStore,
} from "../../services/editor-groups-service";
import type { TerminalServiceStore } from "../../services/terminal-service";
import type {
  EditorPaneId,
  EditorPaneState,
  EditorTab,
  EditorTabId,
  ExternalEditorDropEdge,
  ExternalEditorDropPayload,
} from "../../services/editor-types";
import { resolveEditorDropEdge } from "./edge-resolver";
import { createEditorGroupsOnRenderTabAdapter } from "./onRenderTab-adapter";
import { createEditorGroupsOnRenderTabSetAdapter } from "./onRenderTabSet-adapter";
import { TerminalPaneAdapter } from "./TerminalPaneAdapter";

type EditorGroupTabKind = "file" | "diff" | "terminal" | "preview";
type ApplyWorkspaceEdit = (
  workspaceId: WorkspaceId,
  edit: LspWorkspaceEdit,
) => Promise<LspWorkspaceEditApplicationResult>;

export interface EditorGroup {
  id: string;
  tabs: readonly {
    id: string;
    title?: string;
    kind: EditorGroupTabKind | string;
    workspaceId?: WorkspaceId | null;
    resourcePath?: string | null;
  }[];
  activeTabId: string | null;
}

const EDITOR_GROUP_TAB_COMPONENT = "nexus-editor-group-tab";

export const EDITOR_GROUP_GRID_SLOT_COUNT = 6;
export const EDITOR_GROUP_DOCKABLE_TAB_KINDS: readonly EditorGroupTabKind[] = [
  "file",
  "diff",
  "terminal",
  "preview",
];

export interface EditorGroupsPartProps {
  activeGroupId: string | null;
  groups: readonly EditorGroup[];
  editorGroupsService?: EditorGroupsServiceStore;
  terminalService: TerminalServiceStore;
  layoutSnapshot: unknown;
  model: Model;
  gridShell?: ReactNode;
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  panes: EditorPaneState[];
  activePaneId: EditorPaneId;
  onActivatePane(paneId: EditorPaneId): void;
  onSplitRight(): void;
  onSplitTabRight?(sourcePaneId: EditorPaneId, tabId: EditorTabId, workspaceId?: WorkspaceId | null): void;
  onCloseTab(paneId: EditorPaneId, tabId: EditorTabId): void;
  onCopyTabPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorTab): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: ApplyWorkspaceEdit;
  onDropExternalPayload?(input: DropExternalEditorPayloadInput): void;
  onMoveTerminalToBottomPanel?(sessionId: EditorTabId): void;
}

export function EditorGroupsPart({
  activeGroupId,
  groups,
  editorGroupsService,
  terminalService,
  gridShell,
  layoutSnapshot,
  model,
  activeWorkspaceId,
  activeWorkspaceName,
  panes,
  activePaneId,
  onActivatePane,
  onSplitRight,
  onCloseTab,
  onCopyTabPath,
  onRevealTabInFinder,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  onSplitTabRight,
  onDropExternalPayload,
  onMoveTerminalToBottomPanel,
}: EditorGroupsPartProps): JSX.Element {
  const sectionRef = useRef<HTMLElement | null>(null);
  const internalTerminalDragRef = useRef(false);
  const [nativeDropOverlay, setNativeDropOverlay] = useState<EditorGroupsNativeDropOverlayState | null>(null);
  const panesById = useMemo(() => createPaneLookup(panes), [panes]);
  const paneIdByTabId = useMemo(() => createPaneIdByTabLookup(panes), [panes]);

  const factory = useMemo(() => createEditorGroupsPartFactory({
    activeGroupId,
    activePaneId,
    activeWorkspaceId,
    activeWorkspaceName,
    groups,
    onActivatePane,
    onChangeContent,
    onApplyWorkspaceEdit,
    paneIdByTabId,
    panesById,
    terminalService,
  }), [
    activeGroupId,
    activePaneId,
    activeWorkspaceId,
    activeWorkspaceName,
    groups,
    onActivatePane,
    onChangeContent,
    onApplyWorkspaceEdit,
    paneIdByTabId,
    panesById,
    terminalService,
  ]);

  const handleAction = useCallback((action: Action): Action | undefined => {
    if (action.type === Actions.DELETE_TAB) {
      const tabId = typeof action.data.node === "string" ? action.data.node : null;
      const groupId = tabId ? model.getNodeById(tabId)?.getParent()?.getId() : null;
      if (tabId && groupId) {
        onCloseTab(groupId, tabId);
        return undefined;
      }
    }

    if (action.type === Actions.DELETE_TABSET) {
      const groupId = typeof action.data.node === "string" ? action.data.node : null;
      const group = groupId ? groups.find((candidate) => candidate.id === groupId) : null;
      if (groupId && group) {
        for (const tab of group.tabs) {
          onCloseTab(groupId, tab.id);
        }
        return undefined;
      }
    }

    return action;
  }, [groups, model, onCloseTab]);

  const onRenderTab = useMemo(() => createEditorGroupsOnRenderTabAdapter({
    groups,
    panes,
    onCloseTab,
    onCopyTabPath,
    onRevealTabInFinder,
    onSplitTabRight,
    onMoveTerminalToBottomPanel,
  }), [
    groups,
    onCloseTab,
    onCopyTabPath,
    onMoveTerminalToBottomPanel,
    onRevealTabInFinder,
    onSplitTabRight,
    panes,
  ]);

  const onRenderTabSet = useMemo(() => createEditorGroupsOnRenderTabSetAdapter({
    groups,
    panes,
    onActivateGroup: onActivatePane,
    onSaveTab,
    onSplitRight,
  }), [
    groups,
    onActivatePane,
    onSaveTab,
    onSplitRight,
    panes,
  ]);

  const handleAuxMouseClick = useCallback<NodeMouseEvent>((node, event) => {
    if (event.button !== 1 || !(node instanceof TabNode) || isEditorLayoutTabTarget(event.target)) {
      return;
    }

    const groupId = node.getParent()?.getId();
    if (!groupId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onCloseTab(groupId, node.getId());
  }, [onCloseTab]);

  const clearNativeDropOverlay = useCallback(() => {
    setNativeDropOverlay(null);
  }, []);

  const resolveNativeDrop = useCallback((
    event: DragEvent<HTMLElement>,
  ): ResolvedEditorGroupsNativeDrop | null => {
    if (internalTerminalDragRef.current) {
      return null;
    }

    return resolveEditorGroupsNativeDrop({
      event,
      sectionElement: sectionRef.current,
      groups,
      activeGroupId,
      activePaneId,
      editorGroupsService,
      canDropExternalPayload: Boolean(editorGroupsService || onDropExternalPayload),
    });
  }, [activeGroupId, activePaneId, editorGroupsService, groups, onDropExternalPayload]);

  const handleNativeDragStartCapture = useCallback((event: DragEvent<HTMLElement>) => {
    internalTerminalDragRef.current = writeEditorGroupTerminalTabDragPayloadFromEvent(event, groups);
  }, [groups]);

  const handleNativeDragEndCapture = useCallback(() => {
    internalTerminalDragRef.current = false;
    clearNativeDropOverlay();
  }, [clearNativeDropOverlay]);

  const handleNativeDragEnterCapture = useCallback((event: DragEvent<HTMLElement>) => {
    const dropTarget = resolveNativeDrop(event);
    if (!dropTarget) {
      clearNativeDropOverlay();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setNativeDragDropEffect(event, editorDropEffectForPayload(dropTarget.payload, dropTarget.overlay.folderOnly));
    setNativeDropOverlay(dropTarget.overlay);
  }, [clearNativeDropOverlay, resolveNativeDrop]);

  const handleNativeDragOverCapture = useCallback((event: DragEvent<HTMLElement>) => {
    const dropTarget = resolveNativeDrop(event);
    if (!dropTarget) {
      clearNativeDropOverlay();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setNativeDragDropEffect(event, editorDropEffectForPayload(dropTarget.payload, dropTarget.overlay.folderOnly));
    setNativeDropOverlay(dropTarget.overlay);
  }, [clearNativeDropOverlay, resolveNativeDrop]);

  const handleNativeDragLeaveCapture = useCallback((event: DragEvent<HTMLElement>) => {
    const sectionElement = sectionRef.current;
    if (sectionElement && isPointInsideRect(event.clientX, event.clientY, sectionElement.getBoundingClientRect())) {
      return;
    }

    clearNativeDropOverlay();
  }, [clearNativeDropOverlay]);

  const handleNativeDropCapture = useCallback((event: DragEvent<HTMLElement>) => {
    const dropTarget = resolveNativeDrop(event);
    clearNativeDropOverlay();

    if (!dropTarget) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (dropTarget.overlay.folderOnly) {
      return;
    }

    const dropInput = {
      payload: dropTarget.payload,
      targetGroupId: dropTarget.overlay.targetGroupId,
      edge: dropTarget.overlay.edge,
    };

    if (onDropExternalPayload) {
      onDropExternalPayload(dropInput);
      return;
    }

    editorGroupsService?.getState().dropExternalPayload(dropInput);
  }, [clearNativeDropOverlay, editorGroupsService, onDropExternalPayload, resolveNativeDrop]);

  useEffect(() => {
    if (!nativeDropOverlay) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        clearNativeDropOverlay();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [clearNativeDropOverlay, nativeDropOverlay]);

  return (
    <section
      ref={sectionRef}
      data-component="editor-groups-part"
      data-editor-grid-provider="flexlayout-model"
      data-editor-grid-capacity={EDITOR_GROUP_GRID_SLOT_COUNT}
      data-editor-grid-tab-kinds={EDITOR_GROUP_DOCKABLE_TAB_KINDS.join(" ")}
      data-editor-groups-component={EDITOR_GROUP_TAB_COMPONENT}
      data-editor-groups-serializable={layoutSnapshot ? "true" : "false"}
      className="nexus-flexlayout relative h-full w-full min-h-0 min-w-0 bg-background"
      onDragEnterCapture={handleNativeDragEnterCapture}
      onDragStartCapture={handleNativeDragStartCapture}
      onDragEndCapture={handleNativeDragEndCapture}
      onDragOverCapture={handleNativeDragOverCapture}
      onDragLeaveCapture={handleNativeDragLeaveCapture}
      onDropCapture={handleNativeDropCapture}
    >
      {gridShell ?? <EditorGroupsGridShell groups={groups} />}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {nativeDropOverlay?.announcement ?? ""}
      </span>
      <Layout
        model={model}
        factory={factory}
        onAction={handleAction}
        onAuxMouseClick={handleAuxMouseClick}
        onRenderTab={onRenderTab}
        onRenderTabSet={onRenderTabSet}
        supportsPopout={false}
        realtimeResize
      />
      {nativeDropOverlay ? <EditorGroupsNativeDropOverlay overlay={nativeDropOverlay} /> : null}
    </section>
  );
}

export interface EditorGroupsPartFactoryOptions {
  activeGroupId: string | null;
  activePaneId: EditorPaneId;
  activeWorkspaceId: WorkspaceId | null;
  activeWorkspaceName?: string | null;
  groups: readonly EditorGroup[];
  panesById: ReadonlyMap<EditorPaneId, EditorPaneState>;
  paneIdByTabId: ReadonlyMap<EditorTabId, EditorPaneId>;
  terminalService: TerminalServiceStore;
  onActivatePane(paneId: EditorPaneId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: ApplyWorkspaceEdit;
}

export function createEditorGroupsPartFactory({
  activeGroupId,
  activePaneId,
  activeWorkspaceId,
  activeWorkspaceName,
  groups,
  panesById,
  paneIdByTabId,
  terminalService,
  onActivatePane,
  onChangeContent,
  onApplyWorkspaceEdit,
}: EditorGroupsPartFactoryOptions): (node: TabNode) => JSX.Element {
  return (node: TabNode) => {
    const tabId = node.getId();
    const paneId = node.getParent()?.getId() ?? paneIdByTabId.get(tabId) ?? activePaneId;
    const pane = panesById.get(paneId) ?? createEmptyPane(paneId, tabId);
    const group = groups.find((candidate) => candidate.id === paneId) ?? null;
    const configTab = editorGroupTabFromFlexLayoutConfig(node.getConfig());

    if (configTab?.kind === "terminal") {
      const active = paneId === activeGroupId && (group?.activeTabId ?? tabId) === tabId;

      return (
        <div
          data-editor-flexlayout-tab-content="true"
          data-editor-group-id={pane.id}
          data-editor-group-tab-id={tabId}
          className="h-full min-h-0 min-w-0 bg-background"
        >
          <TerminalPaneAdapter
            sessionId={configTab.id}
            active={active}
            terminalService={terminalService}
          />
        </div>
      );
    }

    const workspaceTabs = activeWorkspaceId
      ? pane.tabs.filter((tab) => tab.workspaceId === activeWorkspaceId)
      : [];
    const activeTabId = workspaceTabs.some((tab) => tab.id === tabId)
      ? tabId
      : normalizeActiveTabId(workspaceTabs, pane.activeTabId);

    return (
      <div
        data-editor-flexlayout-tab-content="true"
        data-editor-group-id={pane.id}
        data-editor-group-tab-id={tabId}
        className="h-full min-h-0 min-w-0 bg-background"
      >
        <EditorPane
          activeWorkspaceName={activeWorkspaceName}
          paneId={pane.id}
          active={pane.id === activeGroupId}
          tabs={workspaceTabs}
          activeTabId={activeTabId}
          onActivatePane={onActivatePane}
          onChangeContent={onChangeContent}
          onApplyWorkspaceEdit={onApplyWorkspaceEdit}
        />
      </div>
    );
  };
}

interface EditorGroupsNativeDropOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface EditorGroupsNativeDropOverlayState {
  targetGroupId: string;
  targetGroupNumber: number;
  edge: ExternalEditorDropEdge;
  altKey: boolean;
  folderOnly: boolean;
  rect: EditorGroupsNativeDropOverlayRect;
  announcement: string;
}

interface ResolvedEditorGroupsNativeDrop {
  payload: ExternalEditorDropPayload;
  overlay: EditorGroupsNativeDropOverlayState;
}

interface EditorGroupsNativeDropTarget {
  groupId: string;
  rect: DOMRectReadOnly;
}

const EDITOR_DROP_OVERLAY_INSET_PX = 4;
const EDITOR_DROP_OVERLAY_FILL = "oklch(var(--color-ring) / 0.12)";
const EDITOR_DROP_OVERLAY_DEFAULT_EDGES = ["top", "right", "bottom", "left", "center"] as const;
const EDITOR_DROP_OVERLAY_ALT_EDGES = [
  "top-left",
  "top",
  "top-right",
  "right",
  "bottom-right",
  "bottom",
  "bottom-left",
  "left",
  "center",
] as const;

export function editorDropOverlayEdgesForAltKey(altKey: boolean): readonly ExternalEditorDropEdge[] {
  return altKey ? EDITOR_DROP_OVERLAY_ALT_EDGES : EDITOR_DROP_OVERLAY_DEFAULT_EDGES;
}

export function isFolderOnlyEditorDropPayload(payload: ExternalEditorDropPayload): boolean {
  switch (payload.type) {
    case "workspace-file":
      return payload.kind === "directory";
    case "workspace-file-multi":
      return payload.items.length > 0 && payload.items.every((item) => item.kind === "directory");
    case "os-file":
    case "terminal-tab":
      return false;
  }
}

export function editorDropAnnouncement(edge: ExternalEditorDropEdge, groupNumber: number): string {
  const normalizedGroupNumber = Math.max(1, Math.floor(groupNumber));
  if (edge === "center") {
    return `Drop into Editor Group ${normalizedGroupNumber}`;
  }

  return `Split ${edge.replace("-", " ")} of Editor Group ${normalizedGroupNumber}`;
}

function EditorGroupsNativeDropOverlay({
  overlay,
}: {
  overlay: EditorGroupsNativeDropOverlayState;
}): JSX.Element {
  const overlayStyle: CSSProperties = {
    left: overlay.rect.left,
    top: overlay.rect.top,
    width: overlay.rect.width,
    height: overlay.rect.height,
  };
  const zoneEdges = editorDropOverlayEdgesForAltKey(overlay.altKey);

  return (
    <div
      aria-hidden="true"
      data-editor-drop-overlay="true"
      data-editor-drop-target-group-id={overlay.targetGroupId}
      data-editor-drop-target-group-number={overlay.targetGroupNumber}
      data-editor-drop-edge={overlay.edge}
      data-editor-drop-corner-zones={overlay.altKey ? "true" : "false"}
      data-editor-drop-folder-only={overlay.folderOnly ? "true" : "false"}
      className="pointer-events-none absolute z-30"
      style={overlayStyle}
    >
      <div
        data-editor-drop-overlay-frame="true"
        className="absolute"
        style={{
          inset: EDITOR_DROP_OVERLAY_INSET_PX,
          border: "1px solid var(--color-ring)",
          borderRadius: "var(--radius)",
          boxShadow: "0 0 0 1px color-mix(in oklch, var(--color-ring) 20%, transparent)",
        }}
      >
        {zoneEdges.map((edge) => (
          <div
            key={edge}
            data-editor-drop-zone={edge}
            data-editor-drop-zone-active={edge === overlay.edge ? "true" : "false"}
            className="absolute"
            style={editorDropZoneStyle(edge, overlay.edge, overlay.altKey)}
          />
        ))}
      </div>
      {overlay.folderOnly ? (
        <div
          role="tooltip"
          data-editor-drop-folder-tooltip="true"
          className="absolute left-1/2 top-1/2 rounded-[var(--radius)] border border-ring bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-lg"
          style={{ transform: "translate(-50%, -50%)" }}
        >
          Drop files, not folders
        </div>
      ) : null}
    </div>
  );
}

export interface EditorGroupsGridShellProps {
  groups: readonly EditorGroup[];
  slotCount?: number;
}

export function EditorGroupsGridShell({
  groups,
  slotCount = EDITOR_GROUP_GRID_SLOT_COUNT,
}: EditorGroupsGridShellProps): JSX.Element {
  const slots = createEditorGroupGridSlots(groups, slotCount);

  return (
    <div
      aria-hidden="true"
      data-editor-grid-shell="true"
      data-editor-grid-slot-count={slotCount}
      data-editor-grid-drop-zones="top right bottom left center"
      className="pointer-events-none absolute inset-0 opacity-0"
    >
      {slots.map((slot) => (
        <div
          key={slot.index}
          data-editor-grid-slot={slot.index}
          data-editor-group-id={slot.groupId ?? ""}
          data-editor-group-tab-count={slot.tabCount}
          data-editor-group-active-tab-id={slot.activeTabId ?? ""}
          data-editor-group-terminal-ready={slot.acceptsTerminal ? "true" : "false"}
          data-editor-group-tab-kinds={EDITOR_GROUP_DOCKABLE_TAB_KINDS.join(" ")}
        />
      ))}
    </div>
  );
}

export interface EditorGroupGridSlot {
  index: number;
  groupId: string | null;
  tabCount: number;
  activeTabId: string | null;
  acceptsTerminal: boolean;
}

export function createEditorGroupGridSlots(
  groups: readonly EditorGroup[],
  slotCount = EDITOR_GROUP_GRID_SLOT_COUNT,
): EditorGroupGridSlot[] {
  return Array.from({ length: slotCount }, (_, index) => {
    const group = groups[index] ?? null;

    return {
      index: index + 1,
      groupId: group?.id ?? null,
      tabCount: group?.tabs.length ?? 0,
      activeTabId: group?.activeTabId ?? null,
      acceptsTerminal: EDITOR_GROUP_DOCKABLE_TAB_KINDS.includes("terminal"),
    };
  });
}

export function terminalTabDragPayloadForEditorGroupTab(
  groups: readonly EditorGroup[],
  tabId: EditorTabId,
): TerminalTabDragData | null {
  for (const group of groups) {
    const tab = group.tabs.find((candidate) => candidate.id === tabId) ?? null;
    if (tab?.kind !== "terminal" || !tab.workspaceId) {
      continue;
    }

    return {
      type: "terminal-tab",
      workspaceId: tab.workspaceId,
      tabId: tab.id,
      source: "editor-group",
      sourceGroupId: group.id,
    };
  }

  return null;
}

export function writeEditorGroupTerminalTabDragPayload(
  dataTransfer: Pick<DataTransfer, "setData" | "effectAllowed">,
  groups: readonly EditorGroup[],
  tabId: EditorTabId,
): boolean {
  const payload = terminalTabDragPayloadForEditorGroupTab(groups, tabId);
  if (!payload) {
    return false;
  }

  writeTerminalTabDragDataTransfer(dataTransfer, payload);
  return true;
}

function writeEditorGroupTerminalTabDragPayloadFromEvent(
  event: Pick<DragEvent<HTMLElement>, "target" | "dataTransfer">,
  groups: readonly EditorGroup[],
): boolean {
  const tabId = editorLayoutTabIdFromDragTarget(event.target);
  return tabId ? writeEditorGroupTerminalTabDragPayload(event.dataTransfer, groups, tabId) : false;
}

function createPaneLookup(panes: readonly EditorPaneState[]): Map<EditorPaneId, EditorPaneState> {
  return new Map(panes.map((pane) => [pane.id, pane]));
}

function createPaneIdByTabLookup(panes: readonly EditorPaneState[]): Map<EditorTabId, EditorPaneId> {
  return new Map(panes.flatMap((pane) => pane.tabs.map((tab) => [tab.id, pane.id] as const)));
}

function createEmptyPane(id: EditorPaneId, activeTabId: EditorTabId | null): EditorPaneState {
  return { id, tabs: [], activeTabId };
}

function editorGroupTabFromFlexLayoutConfig(config: unknown): { id: EditorTabId; kind: string } | null {
  if (!isRecord(config) || !isRecord(config.editorGroupTab)) {
    return null;
  }

  const tab = config.editorGroupTab;
  return typeof tab.id === "string" && typeof tab.kind === "string"
    ? { id: tab.id, kind: tab.kind }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeActiveTabId(tabs: readonly { id: EditorTabId }[], activeTabId: EditorTabId | null): EditorTabId | null {
  return activeTabId && tabs.some((tab) => tab.id === activeTabId)
    ? activeTabId
    : tabs[0]?.id ?? null;
}

function isEditorLayoutTabTarget(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" &&
    target instanceof Element &&
    Boolean(target.closest('[data-editor-layout-tab="true"]'));
}

function editorLayoutTabIdFromDragTarget(target: EventTarget | null): EditorTabId | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return null;
  }

  const directTab = target.closest<HTMLElement>('[data-editor-layout-tab="true"][data-editor-layout-tab-id]');
  if (directTab?.dataset.editorLayoutTabId) {
    return directTab.dataset.editorLayoutTabId;
  }

  const flexLayoutTabButton = target.closest<HTMLElement>("[data-layout-path]");
  const layoutPath = flexLayoutTabButton?.getAttribute("data-layout-path") ?? "";
  if (!/\/tb\d+$/u.test(layoutPath)) {
    return null;
  }

  const tab = flexLayoutTabButton?.querySelector<HTMLElement>(
    '[data-editor-layout-tab="true"][data-editor-layout-tab-id]',
  );
  return tab?.dataset.editorLayoutTabId ?? null;
}

function resolveEditorGroupsNativeDrop({
  event,
  sectionElement,
  groups,
  activeGroupId,
  activePaneId,
  editorGroupsService,
  canDropExternalPayload,
}: {
  event: DragEvent<HTMLElement>;
  sectionElement: HTMLElement | null;
  groups: readonly EditorGroup[];
  activeGroupId: string | null;
  activePaneId: EditorPaneId;
  editorGroupsService?: EditorGroupsServiceStore;
  canDropExternalPayload?: boolean;
}): ResolvedEditorGroupsNativeDrop | null {
  if (!sectionElement || !canDropExternalPayload) {
    return null;
  }

  const payload = readExternalEditorDropPayload(event.dataTransfer, {
    resolveExternalFilePath: resolveNativeFilePathForEditorDrop,
  });
  if (!payload || isEditorGroupsSplitterHit(event, sectionElement)) {
    return null;
  }

  const target = resolveEditorGroupsNativeDropTarget({
    event,
    sectionElement,
    groups,
    activeGroupId,
    activePaneId,
  });
  if (!target) {
    return null;
  }

  const edge = resolveEditorDropEdge({
    clientX: event.clientX,
    clientY: event.clientY,
    rect: target.rect,
    altKey: event.altKey,
    allowCornerEdges: true,
  });
  if (!edge) {
    return null;
  }

  const groupIndex = groups.findIndex((group) => group.id === target.groupId);
  const targetGroupNumber = groupIndex >= 0 ? groupIndex + 1 : 1;
  const folderOnly = isFolderOnlyEditorDropPayload(payload);

  return {
    payload,
    overlay: {
      targetGroupId: target.groupId,
      targetGroupNumber,
      edge,
      altKey: event.altKey,
      folderOnly,
      rect: rectRelativeToSection(target.rect, sectionElement.getBoundingClientRect()),
      announcement: folderOnly
        ? "Drop files, not folders"
        : editorDropAnnouncement(edge, targetGroupNumber),
    },
  };
}

function resolveNativeFilePathForEditorDrop(file: File): string {
  try {
    return globalThis.window?.nexusFileActions?.getPathForFile(file) ?? "";
  } catch {
    return "";
  }
}

function resolveEditorGroupsNativeDropTarget({
  event,
  sectionElement,
  groups,
  activeGroupId,
  activePaneId,
}: {
  event: DragEvent<HTMLElement>;
  sectionElement: HTMLElement;
  groups: readonly EditorGroup[];
  activeGroupId: string | null;
  activePaneId: EditorPaneId;
}): EditorGroupsNativeDropTarget | null {
  const sectionRect = sectionElement.getBoundingClientRect();
  if (!isUsableDomRect(sectionRect)) {
    return null;
  }

  const candidates = findEditorGroupsNativeDropTargets(sectionElement);
  const pointedCandidate = candidates
    .filter((candidate) => isPointInsideRect(event.clientX, event.clientY, candidate.rect))
    .sort((left, right) => rectArea(left.rect) - rectArea(right.rect))[0] ?? null;
  if (pointedCandidate) {
    return pointedCandidate;
  }

  const fallbackGroupId = activeGroupId && groups.some((group) => group.id === activeGroupId)
    ? activeGroupId
    : (groups.some((group) => group.id === activePaneId) ? activePaneId : null) ??
      groups[0]?.id ??
      activePaneId;
  if (!fallbackGroupId) {
    return null;
  }

  return candidates.find((candidate) => candidate.groupId === fallbackGroupId) ?? {
    groupId: fallbackGroupId,
    rect: sectionRect,
  };
}

function findEditorGroupsNativeDropTargets(sectionElement: HTMLElement): EditorGroupsNativeDropTarget[] {
  const targetByGroupId = new Map<string, EditorGroupsNativeDropTarget & { score: number }>();
  const contents = Array.from(
    sectionElement.querySelectorAll<HTMLElement>('[data-editor-flexlayout-tab-content="true"][data-editor-group-id]'),
  );
  const tabsetContainers = Array.from(
    sectionElement.querySelectorAll<HTMLElement>(".flexlayout__tabset_container"),
  ).filter((element) => isUsableDomRect(element.getBoundingClientRect()));

  for (const contentElement of contents) {
    const groupId = contentElement.dataset.editorGroupId;
    const contentRect = contentElement.getBoundingClientRect();
    if (!groupId || !isUsableDomRect(contentRect)) {
      continue;
    }

    const container = findBestIntersectingElement(contentRect, tabsetContainers);
    const rect = container?.getBoundingClientRect() ?? contentRect;
    if (!isUsableDomRect(rect)) {
      continue;
    }

    const score = rectIntersectionArea(rect, contentRect);
    const existing = targetByGroupId.get(groupId);
    if (!existing || score > existing.score) {
      targetByGroupId.set(groupId, { groupId, rect, score });
    }
  }

  return Array.from(targetByGroupId.values()).map(({ groupId, rect }) => ({ groupId, rect }));
}

function findBestIntersectingElement(
  targetRect: DOMRectReadOnly,
  elements: readonly HTMLElement[],
): HTMLElement | null {
  return elements
    .map((element) => ({
      element,
      area: rectIntersectionArea(targetRect, element.getBoundingClientRect()),
    }))
    .filter((candidate) => candidate.area > 0)
    .sort((left, right) => right.area - left.area)[0]?.element ?? null;
}

function isEditorGroupsSplitterHit(event: DragEvent<HTMLElement>, sectionElement: HTMLElement): boolean {
  if (isEditorGroupsSplitterElement(event.target)) {
    return true;
  }

  const elementsFromPoint = sectionElement.ownerDocument.elementsFromPoint?.bind(sectionElement.ownerDocument);
  if (!elementsFromPoint) {
    return false;
  }

  return elementsFromPoint(event.clientX, event.clientY).some((element) =>
    sectionElement.contains(element) && isEditorGroupsSplitterElement(element)
  );
}

function isEditorGroupsSplitterElement(target: EventTarget | null): boolean {
  return typeof Element !== "undefined" &&
    target instanceof Element &&
    Boolean(target.closest([
      ".flexlayout__splitter",
      ".flexlayout__splitter_extra",
      ".flexlayout__splitter_drag",
      ".flexlayout__splitter_handle",
      ".flexlayout__splitter_border",
      '[data-editor-groups-splitter-guard="true"]',
    ].join(",")));
}

function setNativeDragDropEffect(event: DragEvent<HTMLElement>, dropEffect: DataTransfer["dropEffect"]): void {
  event.dataTransfer.dropEffect = dropEffect;
}

function editorDropEffectForPayload(
  payload: ExternalEditorDropPayload,
  folderOnly: boolean,
): DataTransfer["dropEffect"] {
  if (folderOnly) {
    return "none";
  }

  return payload.type === "terminal-tab" ? "move" : "copy";
}

function editorDropZoneStyle(
  edge: ExternalEditorDropEdge,
  activeEdge: ExternalEditorDropEdge,
  includeCornerEdges: boolean,
): CSSProperties {
  const active = edge === activeEdge;

  return {
    ...editorDropZoneRectStyle(edge, includeCornerEdges),
    border: active
      ? "1px solid var(--color-ring)"
      : "1px dashed color-mix(in oklch, var(--color-ring) 28%, transparent)",
    borderRadius: "calc(var(--radius) * 0.75)",
    background: active ? EDITOR_DROP_OVERLAY_FILL : "transparent",
    boxShadow: active
      ? "inset 0 0 0 9999px color-mix(in oklch, var(--color-ring) 12%, transparent)"
      : undefined,
    boxSizing: "border-box",
  };
}

function editorDropZoneRectStyle(edge: ExternalEditorDropEdge, includeCornerEdges: boolean): CSSProperties {
  if (includeCornerEdges) {
    switch (edge) {
      case "top-left":
        return { left: 0, top: 0, width: "33%", height: "33%" };
      case "top":
        return { left: "33%", top: 0, width: "34%", height: "33%" };
      case "top-right":
        return { left: "67%", top: 0, width: "33%", height: "33%" };
      case "right":
        return { left: "67%", top: "33%", width: "33%", height: "34%" };
      case "bottom-right":
        return { left: "67%", top: "67%", width: "33%", height: "33%" };
      case "bottom":
        return { left: "33%", top: "67%", width: "34%", height: "33%" };
      case "bottom-left":
        return { left: 0, top: "67%", width: "33%", height: "33%" };
      case "left":
        return { left: 0, top: "33%", width: "33%", height: "34%" };
      case "center":
        return { left: "33%", top: "33%", width: "34%", height: "34%" };
    }
  }

  switch (edge) {
    case "top":
    case "top-left":
    case "top-right":
      return { left: 0, top: 0, width: "100%", height: "33%" };
    case "right":
    case "bottom-right":
      return { left: "67%", top: "33%", width: "33%", height: "34%" };
    case "bottom":
    case "bottom-left":
      return { left: 0, top: "67%", width: "100%", height: "33%" };
    case "left":
      return { left: 0, top: "33%", width: "33%", height: "34%" };
    case "center":
      return { left: "33%", top: "33%", width: "34%", height: "34%" };
  }
}

function rectRelativeToSection(
  rect: DOMRectReadOnly,
  sectionRect: DOMRectReadOnly,
): EditorGroupsNativeDropOverlayRect {
  return {
    left: rect.left - sectionRect.left,
    top: rect.top - sectionRect.top,
    width: rect.width,
    height: rect.height,
  };
}

function isPointInsideRect(clientX: number, clientY: number, rect: DOMRectReadOnly): boolean {
  return clientX >= rect.left &&
    clientX <= rect.left + rect.width &&
    clientY >= rect.top &&
    clientY <= rect.top + rect.height;
}

function rectArea(rect: DOMRectReadOnly): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function rectIntersectionArea(left: DOMRectReadOnly, right: DOMRectReadOnly): number {
  const xOverlap = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const yOverlap = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  return xOverlap * yOverlap;
}

function isUsableDomRect(rect: DOMRectReadOnly): boolean {
  return Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0;
}
