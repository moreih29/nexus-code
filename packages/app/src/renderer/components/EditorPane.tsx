import { Circle, FileText, Save, SplitSquareHorizontal, X } from "lucide-react";

import type {
  EditorPaneId,
  EditorTab,
  EditorTabId,
  EditorStoreState,
} from "../stores/editor-store";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { MonacoEditorHost } from "./MonacoEditorHost";

export interface EditorPaneProps {
  activeWorkspaceName?: string | null;
  paneId?: EditorPaneId;
  active?: boolean;
  tabs: EditorTab[];
  activeTabId: EditorTabId | null;
  onActivatePane?(paneId: EditorPaneId): void;
  onActivateTab(tabId: EditorTabId): void;
  onCloseTab(tabId: EditorTabId): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
  onSplitRight?(): void;
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
  onActivateTab,
  onCloseTab,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  onSplitRight,
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
        className={cn("h-full bg-background", active && "ring-1 ring-inset ring-[var(--color-ring)]")}
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
        className={cn("h-full bg-background", active && "ring-1 ring-inset ring-[var(--color-ring)]")}
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
        "flex h-full min-h-0 flex-col bg-background transition-[box-shadow]",
        active && "ring-1 ring-inset ring-[var(--color-ring)]",
      )}
      onFocusCapture={handleActivatePane}
      onPointerDown={handleActivatePane}
    >
      <header className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist" aria-label="Open files">
          {tabs.map((tab) => {
            const active = tab.id === activeTab.id;
            return (
              <div
                key={tab.id}
                data-editor-tab-active={active ? "true" : "false"}
                className={cn(
                  "flex h-8 min-w-0 max-w-56 shrink-0 items-center gap-1 rounded-md border border-transparent px-1",
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <button
                  type="button"
                  role="tab"
                  data-action="editor-activate-tab"
                  data-tab-id={tab.id}
                  aria-selected={active}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onActivateTab(tab.id)}
                >
                  {tab.dirty ? (
                    <Circle
                      data-editor-tab-dirty="true"
                      aria-label={`${tab.title} has unsaved changes`}
                      className="size-2 shrink-0 fill-current"
                      strokeWidth={1.75}
                    />
                  ) : null}
                  <span
                    data-editor-tab-title-active={active ? "true" : "false"}
                    className={cn(
                      "truncate",
                      active ? "font-semibold text-foreground" : "font-normal text-muted-foreground",
                    )}
                  >
                    {tab.title}
                  </span>
                </button>
                <Button
                  type="button"
                  data-action="editor-close-tab"
                  data-tab-id={tab.id}
                  aria-label={`Close ${tab.title}`}
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 text-muted-foreground hover:text-foreground"
                  onClick={() => onCloseTab(tab.id)}
                >
                  <X aria-hidden="true" className="size-3" strokeWidth={1.75} />
                </Button>
              </div>
            );
          })}
        </div>
        <Button
          type="button"
          data-action="editor-split-right"
          aria-label={"Split right (⌘\\)"}
          title={"Split right (⌘\\)"}
          variant="ghost"
          size="icon-xs"
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          onClick={onSplitRight}
        >
          <SplitSquareHorizontal aria-hidden="true" className="size-3.5" strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          data-action="editor-save-tab"
          data-tab-id={activeTab.id}
          variant="outline"
          size="xs"
          disabled={!activeTab.dirty || activeTab.saving}
          onClick={() => onSaveTab(activeTab.id)}
        >
          <Save aria-hidden="true" className="size-3" strokeWidth={1.75} />
          {activeTab.saving ? "Saving" : "Save"}
        </Button>
      </header>

      {activeTab.errorMessage ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">
          {activeTab.errorMessage}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 bg-background">
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
      </div>

      <footer className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t border-border px-3 font-mono text-[11px] text-muted-foreground">
        <div className="min-w-0 truncate">
          {activeWorkspaceName} · {activeTab.path}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span>{activeTab.monacoLanguage}</span>
          <span data-lsp-status={activeTab.lspStatus?.state ?? "none"}>
            {formatLspStatus(activeTab)}
          </span>
          <span data-diagnostic-count={activeTab.diagnostics.length}>
            {diagnosticCountLabel(activeTab)}
          </span>
          <span className="hidden sm:inline">Ctrl+F find · Ctrl+H replace</span>
        </div>
      </footer>
    </section>
  );
}

export function formatLspStatus(tab: EditorTab): string {
  if (!tab.language) {
    return "LSP: not available";
  }
  const status = tab.lspStatus;
  if (!status) {
    return "LSP: stopped";
  }
  return `LSP: ${status.state}`;
}

export function diagnosticCountLabel(tab: EditorTab): string {
  if (tab.diagnostics.length === 0) {
    return "0 diagnostics";
  }

  const errors = tab.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = tab.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  if (errors > 0 || warnings > 0) {
    return `${errors} errors · ${warnings} warnings`;
  }

  return `${tab.diagnostics.length} diagnostics`;
}
