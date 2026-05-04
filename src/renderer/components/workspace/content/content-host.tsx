import { createPortal } from "react-dom";
import type { EditorTabProps, Tab, TerminalTabProps } from "@/state/stores/tabs";
import { useHiddenPortalEl } from "./content-pool";
import { EditorView } from "./editor-view";
import { useSlotElement } from "./slot-registry";
import { TerminalView } from "./terminal-view";

interface ContentHostProps {
  workspaceId: string;
  tab: Tab;
  ownerLeafId: string | null;
  isActiveTab: boolean;
  isWorkspaceActive: boolean;
}

export function ContentHost({
  workspaceId,
  tab,
  ownerLeafId,
  isActiveTab,
  isWorkspaceActive,
}: ContentHostProps) {
  const slotEl = useSlotElement(workspaceId, ownerLeafId);
  const hiddenEl = useHiddenPortalEl();
  const target = slotEl ?? hiddenEl;

  const isVisible = isActiveTab && isWorkspaceActive;

  const inner = (
    <div
      className={isVisible ? "absolute inset-0" : "absolute inset-0 invisible pointer-events-none"}
    >
      {tab.type === "terminal" ? (
        <TerminalView tabId={tab.id} cwd={(tab.props as TerminalTabProps).cwd} />
      ) : (
        <EditorView filePath={(tab.props as EditorTabProps).filePath} workspaceId={workspaceId} />
      )}
    </div>
  );

  if (!target) return null;
  return createPortal(inner, target);
}
