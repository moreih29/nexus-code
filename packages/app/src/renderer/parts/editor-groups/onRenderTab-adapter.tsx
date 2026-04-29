import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { Circle, GitCompare, SquareTerminal } from "lucide-react";
import type { ITabRenderValues, TabNode } from "flexlayout-react";

import type { WorkspaceId } from "../../../../../shared/src/contracts/workspace/workspace";
import type { EditorPaneId, EditorPaneState, EditorTab, EditorTabId } from "../../services/editor-types";
import {
  DEFAULT_TAB_CONTEXT_MENU_ACTION_IDS,
  TabContextMenu,
  type TabContextMenuActionId,
  type TabContextMenuTab,
} from "../../components/tab-context-menu";

export interface EditorGroupsOnRenderTabGroupTab {
  id: EditorTabId;
  title?: string;
  kind?: string;
  workspaceId?: WorkspaceId | null;
  resourcePath?: string | null;
}

export interface EditorGroupsOnRenderTabGroup {
  id: EditorPaneId;
  tabs: readonly EditorGroupsOnRenderTabGroupTab[];
  activeTabId: EditorTabId | null;
}

export interface EditorGroupsOnRenderTabAdapterOptions {
  groups: readonly EditorGroupsOnRenderTabGroup[];
  panes: readonly EditorPaneState[];
  onCloseTab(groupId: EditorPaneId, tabId: EditorTabId): void;
  onCopyTabPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorTab): void;
  onSplitTabRight?(sourceGroupId: EditorPaneId, tabId: EditorTabId, workspaceId?: WorkspaceId | null): void;
  onMoveTerminalToBottomPanel?(sessionId: EditorTabId): void;
}

export interface EditorGroupsOnRenderTabState {
  id: EditorTabId;
  groupId: EditorPaneId;
  title: string;
  kind: string;
  label: string;
  dirty: boolean;
  editorTab: EditorTab | null;
  contextTab: EditorGroupsTabContextMenuTab;
  contextTabs: readonly EditorGroupsTabContextMenuTab[];
  contextActionIds: readonly TabContextMenuActionId[];
}

export interface EditorGroupsTabContextMenuTab extends TabContextMenuTab {
  kind: string;
  workspaceId: WorkspaceId | null;
  resourcePath: string | null;
}

export interface TerminalTabLabelInput {
  tabId: EditorTabId;
  title?: string | null;
  config?: unknown;
  terminalOrdinal?: number;
}

type MutableTabRenderValues = ITabRenderValues & { name?: string };
type TabNodeLike = Pick<TabNode, "getId" | "getName" | "getConfig" | "getParent">;

const CLOSE_ONLY_ACTION_IDS: readonly TabContextMenuActionId[] = [
  "close",
  "close-others",
  "close-right",
  "close-all",
];

const FILE_CONTEXT_ACTION_IDS: readonly TabContextMenuActionId[] = DEFAULT_TAB_CONTEXT_MENU_ACTION_IDS;

export function createEditorGroupsOnRenderTabAdapter(
  options: EditorGroupsOnRenderTabAdapterOptions,
): (node: TabNode, renderValues: ITabRenderValues) => void {
  const lookups = createEditorGroupsOnRenderTabLookups(options.groups, options.panes);

  return (node, renderValues) => {
    const state = createEditorGroupsOnRenderTabState(node, lookups);
    const contextActionIds = createContextActionIds(state, options);
    const values = renderValues as MutableTabRenderValues;

    values.leading = null;
    values.content = (
      <TabContextMenu
        paneId={state.groupId}
        tab={state.contextTab}
        tabs={state.contextTabs}
        actionIds={contextActionIds}
        onCloseTab={(_groupId, tabId) => options.onCloseTab(state.groupId, tabId)}
        onCloseOtherTabs={() => closeSiblingTabs(options, state, (tab) => tab.id !== state.id)}
        onCloseTabsToRight={() => {
          const currentIndex = tabIndex(state);
          closeSiblingTabs(options, state, (_tab, index) => currentIndex >= 0 && index > currentIndex);
        }}
        onCloseAllTabs={() => closeSiblingTabs(options, state, () => true)}
        onCopyPath={state.editorTab && options.onCopyTabPath ? (_tab, pathKind) => options.onCopyTabPath?.(state.editorTab!, pathKind) : undefined}
        onRevealInFinder={state.editorTab && options.onRevealTabInFinder ? () => options.onRevealTabInFinder?.(state.editorTab!) : undefined}
        onSplitRight={state.editorTab && options.onSplitTabRight ? () => {
          options.onSplitTabRight?.(state.groupId, state.id, state.editorTab!.workspaceId);
        } : undefined}
        onMoveTerminalToBottomPanel={state.kind === "terminal" && options.onMoveTerminalToBottomPanel
          ? () => options.onMoveTerminalToBottomPanel?.(state.id)
          : undefined}
      >
        <span
          data-editor-layout-tab="true"
          data-editor-layout-tab-id={state.id}
          data-editor-layout-tab-kind={state.kind}
          data-editor-layout-tab-dirty={state.dirty ? "true" : "false"}
          className="flex min-w-0 items-center gap-1"
          onMouseDown={(event) => handleMiddleMouseDown(event, () => options.onCloseTab(state.groupId, state.id))}
        >
          {renderEditorGroupsTabAdornment(state)}
          <span data-editor-layout-tab-label="true" className="truncate">
            {state.label}
          </span>
        </span>
      </TabContextMenu>
    );
    values.name = state.label;
  };
}

export function createEditorGroupsOnRenderTabState(
  node: TabNodeLike,
  lookups: EditorGroupsOnRenderTabLookups,
): EditorGroupsOnRenderTabState {
  const id = node.getId();
  const config = node.getConfig();
  const configTab = editorGroupTabFromConfig(config);
  const groupTab = lookups.groupTabById.get(id) ?? null;
  const editorTab = lookups.editorTabById.get(id) ?? null;
  const kind = groupTab?.kind ?? configTab?.kind ?? editorTab?.kind ?? "file";
  const title = editorTab?.title ?? groupTab?.title ?? configTab?.title ?? node.getName();
  const terminalOrdinal = lookups.terminalOrdinalById.get(id);
  const label = kind === "terminal"
    ? formatTerminalTabLabel({ tabId: id, title, config, terminalOrdinal })
    : title;
  const groupId = node.getParent()?.getId() ?? lookups.groupIdByTabId.get(id) ?? "";
  const group = lookups.groupById.get(groupId) ?? null;
  const contextTabs = (group?.tabs ?? [groupTab ?? configTab ?? { id, title, kind }]).map((tab) =>
    createContextMenuTab(tab, lookups.editorTabById.get(tab.id) ?? null)
  );
  const contextTab = contextTabs.find((tab) => tab.id === id) ?? createContextMenuTab(
    groupTab ?? configTab ?? { id, title, kind },
    editorTab,
  );
  const dirty = kind === "file" && editorTab?.dirty === true;

  return {
    id,
    groupId,
    title,
    kind,
    label,
    dirty,
    editorTab,
    contextTab,
    contextTabs,
    contextActionIds: editorTab ? FILE_CONTEXT_ACTION_IDS : CLOSE_ONLY_ACTION_IDS,
  };
}

export interface EditorGroupsOnRenderTabLookups {
  groupById: ReadonlyMap<EditorPaneId, EditorGroupsOnRenderTabGroup>;
  groupIdByTabId: ReadonlyMap<EditorTabId, EditorPaneId>;
  groupTabById: ReadonlyMap<EditorTabId, EditorGroupsOnRenderTabGroupTab>;
  editorTabById: ReadonlyMap<EditorTabId, EditorTab>;
  terminalOrdinalById: ReadonlyMap<EditorTabId, number>;
}

export function createEditorGroupsOnRenderTabLookups(
  groups: readonly EditorGroupsOnRenderTabGroup[],
  panes: readonly EditorPaneState[],
): EditorGroupsOnRenderTabLookups {
  const groupById = new Map<EditorPaneId, EditorGroupsOnRenderTabGroup>();
  const groupIdByTabId = new Map<EditorTabId, EditorPaneId>();
  const groupTabById = new Map<EditorTabId, EditorGroupsOnRenderTabGroupTab>();
  const terminalOrdinalById = new Map<EditorTabId, number>();
  let terminalOrdinal = 1;

  for (const group of groups) {
    groupById.set(group.id, group);
    for (const tab of group.tabs) {
      groupIdByTabId.set(tab.id, group.id);
      groupTabById.set(tab.id, tab);
      if (tab.kind === "terminal") {
        terminalOrdinalById.set(tab.id, terminalOrdinal);
        terminalOrdinal += 1;
      }
    }
  }

  const editorTabById = new Map<EditorTabId, EditorTab>();
  for (const pane of panes) {
    for (const tab of pane.tabs) {
      editorTabById.set(tab.id, tab);
    }
  }

  return {
    groupById,
    groupIdByTabId,
    groupTabById,
    editorTabById,
    terminalOrdinalById,
  };
}

export function formatTerminalTabLabel({
  tabId,
  title,
  config,
  terminalOrdinal,
}: TerminalTabLabelInput): string {
  const metadata = terminalMetadataFromConfig(config);
  const label = metadata.label;
  if (label) {
    return label;
  }

  const shell = basename(metadata.shell);
  const cwdBasename = basename(metadata.cwd);
  if (shell && cwdBasename) {
    return `${shell}—${cwdBasename}`;
  }

  const fallbackOrdinal = metadata.ordinal ?? terminalNumberFromTitle(title) ?? terminalOrdinal ?? terminalNumberFromId(tabId) ?? 1;
  return `Terminal ${fallbackOrdinal}`;
}

function renderEditorGroupsTabAdornment(state: EditorGroupsOnRenderTabState): ReactNode {
  if (state.kind === "terminal") {
    return (
      <SquareTerminal
        data-editor-layout-tab-terminal-icon="true"
        aria-hidden="true"
        className="size-3.5 shrink-0"
        strokeWidth={1.75}
      />
    );
  }

  if (state.kind === "diff") {
    return (
      <GitCompare
        data-editor-layout-tab-kind-icon="diff"
        aria-hidden="true"
        className="size-3.5 shrink-0"
        strokeWidth={1.75}
      />
    );
  }

  if (state.dirty) {
    return (
      <Circle
        data-editor-tab-dirty="true"
        aria-label={`${state.title} has unsaved changes`}
        className="size-2 shrink-0 fill-current"
        strokeWidth={1.75}
      />
    );
  }

  return null;
}

function handleMiddleMouseDown(
  event: ReactMouseEvent<HTMLElement>,
  onClose: () => void,
): void {
  if (event.button !== 1) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  onClose();
}

function closeSiblingTabs(
  options: EditorGroupsOnRenderTabAdapterOptions,
  state: EditorGroupsOnRenderTabState,
  predicate: (tab: EditorGroupsTabContextMenuTab, index: number) => boolean,
): void {
  state.contextTabs.forEach((tab, index) => {
    if (predicate(tab, index)) {
      options.onCloseTab(state.groupId, tab.id);
    }
  });
}

function tabIndex(state: EditorGroupsOnRenderTabState): number {
  return state.contextTabs.findIndex((tab) => tab.id === state.id);
}

function createContextActionIds(
  state: EditorGroupsOnRenderTabState,
  options: EditorGroupsOnRenderTabAdapterOptions,
): readonly TabContextMenuActionId[] {
  if (state.kind === "terminal") {
    return options.onMoveTerminalToBottomPanel
      ? [...CLOSE_ONLY_ACTION_IDS, "move-to-bottom-panel"]
      : CLOSE_ONLY_ACTION_IDS;
  }

  if (!state.editorTab) {
    return CLOSE_ONLY_ACTION_IDS;
  }

  const actionIds: TabContextMenuActionId[] = [...CLOSE_ONLY_ACTION_IDS];
  if (options.onCopyTabPath) {
    actionIds.push("copy-path", "copy-relative-path");
  }
  if (options.onRevealTabInFinder) {
    actionIds.push("reveal");
  }
  if (options.onSplitTabRight) {
    actionIds.push("split-right");
  }
  return actionIds;
}

function createContextMenuTab(
  tab: EditorGroupsOnRenderTabGroupTab,
  editorTab: EditorTab | null,
): EditorGroupsTabContextMenuTab {
  return {
    id: tab.id,
    title: editorTab?.title ?? tab.title ?? tab.id,
    kind: tab.kind ?? editorTab?.kind ?? "file",
    workspaceId: editorTab?.workspaceId ?? tab.workspaceId ?? null,
    resourcePath: editorTab?.path ?? tab.resourcePath ?? null,
  };
}

interface TerminalTabMetadata {
  label: string | null;
  shell: string | null;
  cwd: string | null;
  ordinal: number | null;
}

function terminalMetadataFromConfig(config: unknown): TerminalTabMetadata {
  const records = terminalMetadataRecords(config);

  return {
    label: firstString(records, ["label"]),
    shell: firstString(records, ["shell", "shellPath", "executable"]),
    cwd: firstString(records, ["cwd", "currentWorkingDirectory", "workingDirectory"]),
    ordinal: firstNumber(records, ["ordinal", "index", "number", "terminalNumber"]),
  };
}

function terminalMetadataRecords(config: unknown): Record<string, unknown>[] {
  if (!isRecord(config)) {
    return [];
  }

  const editorGroupTab = isRecord(config.editorGroupTab) ? config.editorGroupTab : null;
  return [
    config.terminal,
    config.terminalTab,
    config.terminalMetadata,
    editorGroupTab?.terminal,
    editorGroupTab?.terminalTab,
    editorGroupTab?.terminalMetadata,
    editorGroupTab,
  ].filter(isRecord);
}

function firstString(records: readonly Record<string, unknown>[], keys: readonly string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return null;
}

function firstNumber(records: readonly Record<string, unknown>[], keys: readonly string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        return value;
      }
    }
  }
  return null;
}

function editorGroupTabFromConfig(config: unknown): EditorGroupsOnRenderTabGroupTab | null {
  if (!isRecord(config) || !isRecord(config.editorGroupTab)) {
    return null;
  }

  const tab = config.editorGroupTab;
  if (typeof tab.id !== "string") {
    return null;
  }

  return {
    id: tab.id,
    title: typeof tab.title === "string" ? tab.title : undefined,
    kind: typeof tab.kind === "string" ? tab.kind : undefined,
    workspaceId: typeof tab.workspaceId === "string" ? tab.workspaceId as WorkspaceId : null,
    resourcePath: typeof tab.resourcePath === "string" ? tab.resourcePath : null,
  };
}

function basename(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/[\\/]+$/u, "");
  if (trimmed.length === 0) {
    return value.trim();
  }

  const parts = trimmed.split(/[\\/]/u).filter((part) => part.length > 0);
  return parts.at(-1) ?? trimmed;
}

function terminalNumberFromTitle(title: string | null | undefined): number | null {
  const match = title?.match(/^Terminal\s+(\d+)$/iu);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function terminalNumberFromId(tabId: EditorTabId): number | null {
  const match = tabId.match(/(?:terminal|term)[^\d]*(\d+)$/iu);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
