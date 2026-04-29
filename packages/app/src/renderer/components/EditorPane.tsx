import type {
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type {
  EditorPaneId,
  EditorTab,
  EditorTabId,
} from "../services/editor-types";
import { cn } from "@/lib/utils";
import { EmptyState } from "./EmptyState";
import { DiffEditorHost } from "./DiffEditorHost";
import { MonacoEditorHost } from "./MonacoEditorHost";
import { FileText } from "lucide-react";

const PANE_FOCUS_VISIBLE_OUTLINE_CLASS =
  "outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-[-1px] focus-visible:outline-ring has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-[-1px] has-[:focus-visible]:outline-ring";

type ApplyWorkspaceEdit = (
  workspaceId: EditorTab["workspaceId"],
  edit: LspWorkspaceEdit,
) => Promise<LspWorkspaceEditApplicationResult>;

export interface EditorPaneProps {
  activeWorkspaceName?: string | null;
  paneId?: EditorPaneId;
  active?: boolean;
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
  onActivatePane?(paneId: EditorPaneId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: ApplyWorkspaceEdit;
}

export function EditorPane(props: EditorPaneProps): JSX.Element {
  return <EditorPaneView {...props} />;
}

export function EditorPaneView({
  activeWorkspaceName,
  paneId = "p0",
  active = true,
  tabs,
  activeTabId,
  onActivatePane,
  onChangeContent,
  onApplyWorkspaceEdit,
}: EditorPaneProps): JSX.Element {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const handleActivatePane = () => {
    onActivatePane?.(paneId);
  };

  if (!activeWorkspaceName) {
    return (
      <section
        data-component="editor-pane"
        data-editor-pane-id={paneId}
        data-active={active ? "true" : "false"}
        role="region"
        aria-label="Editor pane"
        className={cn("h-full bg-background", PANE_FOCUS_VISIBLE_OUTLINE_CLASS)}
        onFocusCapture={handleActivatePane}
        onPointerDown={handleActivatePane}
      >
        <EmptyState
          icon={FileText}
          title="No workspace selected"
          description="Open a workspace to edit files."
        />
      </section>
    );
  }

  if (!activeTab) {
    return (
      <section
        data-component="editor-pane"
        data-editor-pane-id={paneId}
        data-active={active ? "true" : "false"}
        role="region"
        aria-label="Editor pane"
        className={cn("h-full bg-background", PANE_FOCUS_VISIBLE_OUTLINE_CLASS)}
        onFocusCapture={handleActivatePane}
        onPointerDown={handleActivatePane}
      >
        <EmptyState
          icon={FileText}
          title="No file open"
          description="Open a file from the file tree to edit it."
        />
      </section>
    );
  }

  return (
    <section
      data-component="editor-pane"
      data-editor-pane-id={paneId}
      data-active={active ? "true" : "false"}
      role="region"
      aria-label="Editor pane"
      className={cn(
        "flex h-full min-h-0 flex-col bg-background",
        PANE_FOCUS_VISIBLE_OUTLINE_CLASS,
      )}
      onFocusCapture={handleActivatePane}
      onPointerDown={handleActivatePane}
    >
      <div className="min-h-0 flex-1 bg-background">
        {activeTab.kind === "diff" && activeTab.diff ? (
          <DiffEditorHost
            key={activeTab.id}
            left={activeTab.diff.left}
            right={activeTab.diff.right}
          />
        ) : (
          <MonacoEditorHost
            key={activeTab.id}
            workspaceId={activeTab.workspaceId}
            path={activeTab.path}
            languageId={activeTab.monacoLanguage}
            lspLanguage={activeTab.language}
            value={activeTab.content}
            diagnostics={activeTab.diagnostics}
            onChange={(content) => onChangeContent(activeTab.id, content)}
            onApplyWorkspaceEdit={onApplyWorkspaceEdit}
          />
        )}
      </div>
    </section>
  );
}
