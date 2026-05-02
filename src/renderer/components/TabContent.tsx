import { TerminalView } from "./TerminalView";
import { EditorView } from "./EditorView";
import type { Tab } from "../store/tabs";
import type { EditorTabProps, TerminalTabProps } from "../store/tabs";

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
      <div
        className="tab-content"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-muted)",
          fontSize: 13,
        }}
      >
        No tab open
      </div>
    );
  }

  return (
    <div className="tab-content">
      {tab.type === "terminal" ? (
        <TerminalView
          tabId={tab.id}
          cwd={(tab.props as TerminalTabProps).cwd}
        />
      ) : (
        <EditorView
          filePath={(tab.props as EditorTabProps).filePath}
          workspaceId={(tab.props as EditorTabProps).workspaceId}
        />
      )}
    </div>
  );
}
