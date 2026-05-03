import type { EditorTabProps, Tab, TerminalTabProps } from "../../../store/tabs";
import { EditorView } from "../content/editor-view";
import { TerminalView } from "../content/terminal-view";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TabContentProps {
  tab: Tab | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TabContent({ tab }: TabContentProps) {
  if (!tab) {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-muted-foreground text-app-body">
        No tab open
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden">
      {tab.type === "terminal" ? (
        <TerminalView tabId={tab.id} cwd={(tab.props as TerminalTabProps).cwd} />
      ) : (
        <EditorView
          filePath={(tab.props as EditorTabProps).filePath}
          workspaceId={(tab.props as EditorTabProps).workspaceId}
        />
      )}
    </div>
  );
}
