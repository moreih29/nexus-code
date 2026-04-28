import { Fragment, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";

import { SortableContext, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { Circle, FileText, GitCompare, Save, SplitSquareHorizontal, X } from "lucide-react";

import type {
  EditorPaneId,
  EditorTab,
  EditorTabId,
  EditorStoreState,
} from "../stores/editor-store";
import { cn } from "@/lib/utils";
import {
  createEditorTabDragData,
  editorTabDragId,
} from "./editor-tabs/drag-and-drop";
import { TabContextMenu } from "./tab-context-menu";
import { Button } from "./ui/button";
import { EmptyState } from "./EmptyState";
import { DiffEditorHost } from "./DiffEditorHost";
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
  onCloseOtherTabs?(tabId: EditorTabId): void;
  onCloseTabsToRight?(tabId: EditorTabId): void;
  onCloseAllTabs?(): void;
  onCopyTabPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorTab): void;
  onSaveTab(tabId: EditorTabId): void;
  onChangeContent(tabId: EditorTabId, content: string): void;
  onApplyWorkspaceEdit?: EditorStoreState["applyWorkspaceEdit"];
  onSplitRight?(): void;
  enableTabDrag?: boolean;
  draggingTabId?: EditorTabId | null;
  tabDropIndicatorIndex?: number | null;
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
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSaveTab,
  onChangeContent,
  onApplyWorkspaceEdit,
  onSplitRight,
  enableTabDrag = false,
  draggingTabId = null,
  tabDropIndicatorIndex = null,
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
          <EditorTabSortableContext paneId={paneId} tabs={tabs} enabled={enableTabDrag}>
            {tabs.map((tab, index) => {
            const isTabActive = tab.id === activeTab.id;
            return (
              <Fragment key={tab.id}>
                <EditorTabDropIndicator visible={tabDropIndicatorIndex === index} />
                {enableTabDrag ? (
                  <SortableEditorTab
                    paneId={paneId}
                    tab={tab}
                    index={index}
                    active={active}
                    isTabActive={isTabActive}
                    dragging={draggingTabId === tab.id}
                    tabs={tabs}
                    onActivateTab={onActivateTab}
                    onCloseTab={onCloseTab}
                    onCloseOtherTabs={onCloseOtherTabs}
                    onCloseTabsToRight={onCloseTabsToRight}
                    onCloseAllTabs={onCloseAllTabs}
                    onCopyTabPath={onCopyTabPath}
                    onRevealTabInFinder={onRevealTabInFinder}
                    onSplitRight={onSplitRight}
                  />
                ) : (
                  <EditorTabView
                    tab={tab}
                    active={active}
                    isTabActive={isTabActive}
                    dragging={draggingTabId === tab.id}
                    paneId={paneId}
                    tabs={tabs}
                    onActivateTab={onActivateTab}
                    onCloseTab={onCloseTab}
                    onCloseOtherTabs={onCloseOtherTabs}
                    onCloseTabsToRight={onCloseTabsToRight}
                    onCloseAllTabs={onCloseAllTabs}
                    onCopyTabPath={onCopyTabPath}
                    onRevealTabInFinder={onRevealTabInFinder}
                    onSplitRight={onSplitRight}
                  />
                )}
              </Fragment>
            );
          })}
          <EditorTabDropIndicator visible={tabDropIndicatorIndex === tabs.length} />
          </EditorTabSortableContext>
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
        {activeTab.kind === "diff" ? (
          <span
            data-editor-tab-read-only="true"
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground"
          >
            Read-only
          </span>
        ) : (
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
        )}
      </header>

      {activeTab.errorMessage ? (
        <div className="shrink-0 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive-foreground">
          {activeTab.errorMessage}
        </div>
      ) : null}

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

      <footer className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t border-border px-3 font-mono text-[11px] text-muted-foreground">
        <div className="min-w-0 truncate">
          {activeWorkspaceName} · {activeTab.kind === "diff" && activeTab.diff
            ? `${activeTab.diff.left.path} ↔ ${activeTab.diff.right.path}`
            : activeTab.path}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {activeTab.kind === "diff" ? (
            <>
              <span>Diff</span>
              <span>j/k change navigation</span>
            </>
          ) : (
            <>
              <span>{activeTab.monacoLanguage}</span>
              <span data-lsp-status={activeTab.lspStatus?.state ?? "none"}>
                {formatLspStatus(activeTab)}
              </span>
              <span data-diagnostic-count={activeTab.diagnostics.length}>
                {diagnosticCountLabel(activeTab)}
              </span>
              <span className="hidden sm:inline">Ctrl+F find · Ctrl+H replace</span>
            </>
          )}
        </div>
      </footer>
    </section>
  );
}

function EditorTabSortableContext({
  paneId,
  tabs,
  enabled,
  children,
}: {
  paneId: EditorPaneId;
  tabs: readonly EditorTab[];
  enabled: boolean;
  children: ReactNode;
}): JSX.Element {
  if (!enabled) {
    return <>{children}</>;
  }

  return (
    <SortableContext
      items={tabs.map((tab) => editorTabDragId(paneId, tab.id))}
      strategy={horizontalListSortingStrategy}
    >
      {children}
    </SortableContext>
  );
}

interface SortableEditorTabProps {
  paneId: EditorPaneId;
  tab: EditorTab;
  index: number;
  active: boolean;
  isTabActive: boolean;
  dragging: boolean;
  tabs: readonly EditorTab[];
  onActivateTab(tabId: EditorTabId): void;
  onCloseTab(tabId: EditorTabId): void;
  onCloseOtherTabs?(tabId: EditorTabId): void;
  onCloseTabsToRight?(tabId: EditorTabId): void;
  onCloseAllTabs?(): void;
  onCopyTabPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorTab): void;
  onSplitRight?(): void;
}

function SortableEditorTab({
  paneId,
  tab,
  index,
  active,
  isTabActive,
  dragging,
  tabs,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSplitRight,
}: SortableEditorTabProps): JSX.Element {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: editorTabDragId(paneId, tab.id),
    data: createEditorTabDragData(paneId, tab.id, index),
  });
  const style: CSSProperties = {
    transform: transform
      ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`
      : undefined,
    transition,
  };

  return (
    <EditorTabView
      ref={setNodeRef}
      tab={tab}
      active={active}
      isTabActive={isTabActive}
      dragging={dragging || isDragging}
      paneId={paneId}
      tabs={tabs}
      onActivateTab={onActivateTab}
      onCloseTab={onCloseTab}
      onCloseOtherTabs={onCloseOtherTabs}
      onCloseTabsToRight={onCloseTabsToRight}
      onCloseAllTabs={onCloseAllTabs}
      onCopyTabPath={onCopyTabPath}
      onRevealTabInFinder={onRevealTabInFinder}
      onSplitRight={onSplitRight}
      sortableAttributes={attributes as HTMLAttributes<HTMLDivElement>}
      sortableListeners={(listeners ?? undefined) as HTMLAttributes<HTMLDivElement> | undefined}
      style={style}
    />
  );
}

interface EditorTabViewProps {
  paneId: EditorPaneId;
  tab: EditorTab;
  tabs: readonly EditorTab[];
  active: boolean;
  isTabActive: boolean;
  dragging: boolean;
  onActivateTab(tabId: EditorTabId): void;
  onCloseTab(tabId: EditorTabId): void;
  onCloseOtherTabs?(tabId: EditorTabId): void;
  onCloseTabsToRight?(tabId: EditorTabId): void;
  onCloseAllTabs?(): void;
  onCopyTabPath?(tab: EditorTab, pathKind: "absolute" | "relative"): void;
  onRevealTabInFinder?(tab: EditorTab): void;
  onSplitRight?(): void;
  sortableAttributes?: HTMLAttributes<HTMLDivElement>;
  sortableListeners?: HTMLAttributes<HTMLDivElement>;
  style?: CSSProperties;
}

function EditorTabView({
  tab,
  paneId,
  tabs,
  active,
  isTabActive,
  dragging,
  onActivateTab,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onCopyTabPath,
  onRevealTabInFinder,
  onSplitRight,
  sortableAttributes,
  sortableListeners,
  style,
  ref,
}: EditorTabViewProps & { ref?: Ref<HTMLDivElement> }): JSX.Element {
  const tabContent = (
    <div
      ref={ref}
      {...sortableAttributes}
      {...sortableListeners}
      data-editor-tab-active={isTabActive ? "true" : "false"}
      data-editor-tab-dragging={dragging ? "true" : "false"}
      style={style}
      className={cn(
        "flex h-8 min-w-0 max-w-56 shrink-0 touch-none items-center gap-1 rounded-md border border-transparent px-1",
        isTabActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
        dragging && "opacity-60",
      )}
    >
      <button
        type="button"
        role="tab"
        data-action="editor-activate-tab"
        data-tab-id={tab.id}
        aria-selected={isTabActive}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm px-1 py-1 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onActivateTab(tab.id)}
      >
        {tab.kind === "diff" ? (
          <GitCompare
            data-editor-tab-kind="diff"
            aria-hidden="true"
            className="size-3.5 shrink-0"
            strokeWidth={1.75}
          />
        ) : tab.dirty ? (
          <Circle
            data-editor-tab-dirty="true"
            aria-label={`${tab.title} has unsaved changes`}
            className="size-2 shrink-0 fill-current"
            strokeWidth={1.75}
          />
        ) : null}
        <span
          data-editor-tab-title-active={isTabActive ? "true" : "false"}
          className={cn(
            "truncate",
            isTabActive && active
              ? "font-semibold text-foreground"
              : "font-normal text-muted-foreground",
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

  return (
    <TabContextMenu
      paneId={paneId}
      tab={tab}
      tabs={tabs}
      onCloseTab={(_paneId, tabId) => onCloseTab(tabId)}
      onCloseOtherTabs={(_paneId, tabId) => onCloseOtherTabs?.(tabId)}
      onCloseTabsToRight={(_paneId, tabId) => onCloseTabsToRight?.(tabId)}
      onCloseAllTabs={() => onCloseAllTabs?.()}
      onCopyPath={onCopyTabPath}
      onRevealInFinder={onRevealTabInFinder}
      onSplitRight={() => onSplitRight?.()}
    >
      {tabContent}
    </TabContextMenu>
  );
}

function EditorTabDropIndicator({ visible }: { visible: boolean }): JSX.Element | null {
  if (!visible) {
    return null;
  }

  return (
    <div
      aria-hidden="true"
      data-editor-tab-drop-indicator="true"
      className="h-6 w-px shrink-0 rounded-full bg-primary"
    />
  );
}

export function formatLspStatus(tab: EditorTab): string {
  if (tab.kind === "diff") {
    return "LSP: read-only diff";
  }
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
  if (tab.kind === "diff") {
    return "Read-only diff";
  }
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
