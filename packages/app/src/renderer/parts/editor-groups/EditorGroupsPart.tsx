import type { ReactNode } from "react";

import { SplitEditorPane, type SplitEditorPaneProps } from "../../components/SplitEditorPane";
import {
  EDITOR_GROUP_TAB_COMPONENT,
  type EditorGroup,
  type EditorGroupTabKind,
  type EditorGroupsServiceStore,
} from "../../services/editor-groups-service";

export const EDITOR_GROUP_GRID_SLOT_COUNT = 6;
export const EDITOR_GROUP_DOCKABLE_TAB_KINDS: readonly EditorGroupTabKind[] = [
  "file",
  "diff",
  "terminal",
  "preview",
];

export interface EditorGroupsPartProps extends SplitEditorPaneProps {
  editorGroupsService?: EditorGroupsServiceStore | null;
  gridShell?: ReactNode;
}

export function EditorGroupsPart({ editorGroupsService = null, gridShell, ...splitEditorPaneProps }: EditorGroupsPartProps): JSX.Element {
  const groups = editorGroupsService?.getState().groups ?? [];
  const serializedModel = editorGroupsService?.getState().serializeModel();

  return (
    <section
      data-component="editor-groups-part"
      data-editor-grid-provider={editorGroupsService ? "flexlayout-model" : "legacy-split-pane-bridge"}
      data-editor-grid-capacity={EDITOR_GROUP_GRID_SLOT_COUNT}
      data-editor-grid-tab-kinds={EDITOR_GROUP_DOCKABLE_TAB_KINDS.join(" ")}
      data-editor-groups-component={EDITOR_GROUP_TAB_COMPONENT}
      data-editor-groups-serializable={serializedModel ? "true" : "false"}
      className="relative h-full min-h-0 min-w-0 bg-background"
    >
      {gridShell ?? <EditorGroupsGridShell groups={groups} />}
      <SplitEditorPane {...splitEditorPaneProps} />
    </section>
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
