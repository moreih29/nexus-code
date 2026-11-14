import i18next from "i18next";
import { Bot, Folder, GitBranch, NotebookPen, Search } from "lucide-react";
import { memo, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { ipcCallResult } from "../../ipc/client";
import { openDiffTab } from "../../state/operations";
import { useActiveStore } from "../../state/stores/active";
import { useGitStore } from "../../state/stores/git";
import {
  FILES_PANEL_MODE_DEFAULT,
  FILES_PANEL_WIDTH_DEFAULT,
  FILES_PANEL_WIDTH_MAX,
  FILES_PANEL_WIDTH_MIN,
  type FilesPanelMode,
  useUIStore,
} from "../../state/stores/ui";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "../../state/stores/workspaces";
import { AgentsPanel } from "../agent-list/agents-panel";
import { EMPTY_TREE } from "../editor/diff-refs";
import { NotesPanel } from "../notes/notes-panel";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorBoundary } from "../ui/error-boundary";
import { ResizeHandle } from "../ui/resize-handle";
import { showToast } from "../ui/toast";
import { FileTree } from "./file-tree";
import { GitPanel, type GitPanelOpenDiffInput } from "./git";
import { SearchPanel } from "./search/panel";

interface ModeButton {
  mode: FilesPanelMode;
  labelKey: string;
  Icon: typeof Folder;
}

const MODE_BUTTONS: ModeButton[] = [
  { mode: "tree", labelKey: "files:panel.tab.tree", Icon: Folder },
  { mode: "search", labelKey: "files:panel.tab.search", Icon: Search },
  { mode: "git", labelKey: "files:panel.tab.git", Icon: GitBranch },
  // The agent list; the same mark as the agent view's.
  { mode: "agents", labelKey: "files:panel.tab.agents", Icon: Bot },
  // The workspace's notes, kept by the app: there even when an SSH workspace is not connected.
  { mode: "notes", labelKey: "files:panel.tab.notes", Icon: NotebookPen },
];

// ---------------------------------------------------------------------------
// Reconnect helper — exported so unit tests can verify the async logic
// without mounting the full component.
// ---------------------------------------------------------------------------

/**
 * Attempts to reconnect the SSH workspace.
 * - Success: the main process broadcasts a connectionChanged event and the store updates.
 * - Failure: the user is told with a toast.
 *
 * The `workspace.activate` IPC calls `ensureProviderReady` internally, so calling it again
 * after the previous connection failed (the sshProviderReady cache was removed) starts a
 * new SSH bootstrap.
 */
export async function reconnectWorkspace(
  workspaceId: string,
  deps: {
    callActivate: (id: string) => Promise<{ ok: boolean; message?: string }>;
    onError: (message: string) => void;
  },
): Promise<void> {
  const result = await deps.callActivate(workspaceId);
  if (!result.ok) {
    deps.onError(i18next.t("files:panel.reconnectError"));
  }
}

// Memo: kept while hidden, it would render again with each of the app's.
export const FilesPanel = memo(function FilesPanel() {
  const { t } = useTranslation("files");
  const filesPanelWidth = useUIStore((s) => s.filesPanelWidth);
  const setFilesPanelMode = useUIStore((s) => s.setFilesPanelMode);
  const activeWorkspaceId = useActiveStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const activeWorkspace = activeWorkspaceId
    ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? null)
    : null;
  // Per-workspace mode: subscribe by workspace id so switching workspaces
  // pulls a fresh value instead of carrying the previous one over.
  const filesPanelMode = useUIStore(
    (s) =>
      (activeWorkspace ? s.filesPanelModes.get(activeWorkspace.id) : undefined) ??
      FILES_PANEL_MODE_DEFAULT,
  );
  const workspaceOnline = useWorkspacesStore((s) =>
    activeWorkspace ? selectIsWorkspaceOnline(s, activeWorkspace.id) : true,
  );

  // For disconnected SSH and WSL workspaces, suppress all remote-reading panels so
  // no IPC call reaches getFs / getAgentChannel before the user connects.
  const showOffline =
    activeWorkspace !== null && activeWorkspace.location.kind !== "local" && !workspaceOnline;

  // Whether a reconnect is in progress — used to disable the Reconnect button and change its label.
  const [isReconnecting, setIsReconnecting] = useState(false);
  // Bumped by each click on the Search button so the panel focuses its input,
  // whether the click mounts it or it is already showing.
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);

  const handleReconnect = (): void => {
    if (!activeWorkspace || isReconnecting) return;
    setIsReconnecting(true);
    void reconnectWorkspace(activeWorkspace.id, {
      callActivate: (id) => ipcCallResult("workspace", "activate", { id }),
      onError: (message) => showToast({ kind: "error", message }),
    }).finally(() => {
      setIsReconnecting(false);
    });
  };

  return (
    <aside className="relative shrink-0 flex flex-col" style={{ width: filesPanelWidth }}>
      <div className="flex flex-col flex-1 min-h-0 island-surface rounded-(--radius-island) overflow-hidden">
        {activeWorkspace ? (
          <>
            <div className="flex items-center gap-1 px-2 pt-2 pb-2 border-b border-border/50">
              {MODE_BUTTONS.map(({ mode, labelKey, Icon }) => {
                const isActive = filesPanelMode === mode;
                const label = t(labelKey);
                return (
                  <Button
                    key={mode}
                    variant="ghost"
                    size="icon-sm"
                    aria-label={label}
                    aria-pressed={isActive}
                    title={label}
                    // The panel shown, drawn like an active tab: a tint and an
                    // underline indicator (design.md §8, "selected"). aria-pressed
                    // carries it to assistive tech.
                    className={cn(
                      "relative",
                      isActive && [
                        "bg-[var(--sidebar-item-selected-bg)] text-foreground",
                        "after:absolute after:right-1.5 after:bottom-0 after:left-1.5 after:h-0.5",
                        "after:rounded-full after:bg-[var(--state-selected-indicator)] after:content-['']",
                      ],
                    )}
                    onClick={() => {
                      setFilesPanelMode(activeWorkspace.id, mode);
                      if (mode === "search") setSearchFocusRequest((n) => n + 1);
                    }}
                  >
                    <Icon />
                  </Button>
                );
              })}
            </div>
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {filesPanelMode === "notes" ? (
                // ErrorBoundary: a notes panel crash leaves the other views working.
                <ErrorBoundary logSource="notes-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <NotesPanel key={activeWorkspace.id} workspace={activeWorkspace} />
                  </div>
                </ErrorBoundary>
              ) : showOffline ? (
                <EmptyState
                  title={t("panel.offline.title")}
                  description={t("panel.offline.description")}
                  tone="status"
                  actionLabel={
                    isReconnecting ? t("panel.offline.reconnecting") : t("panel.offline.reconnect")
                  }
                  onAction={handleReconnect}
                  disabled={isReconnecting}
                />
              ) : filesPanelMode === "tree" ? (
                // ErrorBoundary: a crash in the file tree must not collapse
                // the entire sidebar or prevent switching to other modes.
                <ErrorBoundary logSource="file-tree-panel">
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <FileTree
                      workspaceId={activeWorkspace.id}
                      rootAbsPath={activeWorkspace.rootPath}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "search" ? (
                // ErrorBoundary: search panel crash is isolated — git and file
                // tree panels remain functional.
                <ErrorBoundary logSource="search-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {/* Keyed so the query input and options belong to one
                        workspace; they are restored from its search session. */}
                    <SearchPanel
                      key={activeWorkspace.id}
                      workspaceId={activeWorkspace.id}
                      focusRequest={searchFocusRequest}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "git" ? (
                // ErrorBoundary: git panel crash is isolated — the editor and
                // terminal panels in the workspace remain unaffected.
                <ErrorBoundary logSource="git-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    <GitPanel
                      workspaceId={activeWorkspace.id}
                      workspaceRootPath={activeWorkspace.rootPath}
                      onOpenDiff={openGitDiffFromRow}
                    />
                  </div>
                </ErrorBoundary>
              ) : filesPanelMode === "agents" ? (
                // ErrorBoundary: an agent list crash leaves the other views working.
                <ErrorBoundary logSource="agent-list-panel">
                  <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {/* Keyed so a search and an open card belong to one workspace. */}
                    <AgentsPanel key={activeWorkspace.id} workspace={activeWorkspace} />
                  </div>
                </ErrorBoundary>
              ) : (
                <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="whitespace-pre-line px-4 text-center text-app-ui-sm text-muted-foreground">
              {t("panel.noWorkspace")}
            </div>
          </div>
        )}
      </div>
      <ResizeHandle
        value={filesPanelWidth}
        min={FILES_PANEL_WIDTH_MIN}
        max={FILES_PANEL_WIDTH_MAX}
        ariaLabel={t("panel.resize")}
        onResize={(width, persist) => useUIStore.getState().setFilesPanelWidth(width, persist)}
        onReset={() => useUIStore.getState().setFilesPanelWidth(FILES_PANEL_WIDTH_DEFAULT, true)}
      />
    </aside>
  );
});

function openGitDiffFromRow({
  workspaceId,
  groupKey,
  entry,
  preview,
}: GitPanelOpenDiffInput): void {
  const isUnborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  const refs = refsForGitGroup(groupKey, isUnborn);
  // When preview is unspecified, defer to openDiffTab's default (preview=true) — the same
  // temporary-slot reuse flow as a file tree single-click. A double-click promotes it to
  // permanent with `preview=false`.
  openDiffTab(workspaceId, entry.relPath, refs.leftRef, refs.rightRef, entry.oldRelPath, {
    ...(preview === false ? { preview: false } : {}),
  });
}

export function refsForGitGroup(
  groupKey: GitPanelOpenDiffInput["groupKey"],
  isUnborn: boolean,
): {
  leftRef: string;
  rightRef: string;
} {
  if (groupKey === "staged") return { leftRef: isUnborn ? EMPTY_TREE : "HEAD", rightRef: "INDEX" };
  if (groupKey === "working") return { leftRef: "INDEX", rightRef: "WORKING" };
  return { leftRef: isUnborn ? EMPTY_TREE : "HEAD", rightRef: "WORKING" };
}
