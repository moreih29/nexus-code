import type { EditorTabProps, Tab, TerminalTabProps } from "../../../store/tabs";
import { EditorView } from "../../EditorView";
import { TerminalView } from "../../TerminalView";
import { useSlotRect } from "./useSlotRect";

interface ContentHostProps {
  workspaceId: string;
  tab: Tab;
  ownerLeafId: string | null;
  isActiveTab: boolean;
  isWorkspaceActive: boolean;
  poolRef: React.RefObject<HTMLDivElement>;
}

export function ContentHost({
  workspaceId,
  tab,
  ownerLeafId,
  isActiveTab,
  isWorkspaceActive,
  poolRef,
}: ContentHostProps) {
  const rect = useSlotRect(poolRef, ownerLeafId);

  const isVisible = isActiveTab && isWorkspaceActive;
  const visibilityClass =
    rect !== null && isVisible ? "pointer-events-auto" : "invisible pointer-events-none";

  return (
    <div
      className={`absolute ${visibilityClass}`}
      style={
        rect !== null
          ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : { top: 0, left: 0, width: 0, height: 0 }
      }
    >
      {tab.type === "terminal" ? (
        <TerminalView tabId={tab.id} cwd={(tab.props as TerminalTabProps).cwd} />
      ) : (
        <EditorView filePath={(tab.props as EditorTabProps).filePath} workspaceId={workspaceId} />
      )}
    </div>
  );
}
