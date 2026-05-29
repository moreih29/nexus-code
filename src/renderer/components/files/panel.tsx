import { useState } from "react";
import { Folder, GitBranch, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
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
import { EMPTY_TREE } from "../editor/diff-refs";
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
];

// ---------------------------------------------------------------------------
// Reconnect helper — exported so unit tests can verify the async logic
// without mounting the full component.
// ---------------------------------------------------------------------------

/**
 * SSH 워크스페이스 재연결을 시도한다.
 * - 성공: main 프로세스가 connectionChanged 이벤트를 broadcast해 store가 업데이트됨.
 * - 실패: 사용자에게 토스트로 안내.
 *
 * `workspace.activate` IPC는 내부적으로 `ensureProviderReady`를 호출하므로,
 * 이전 연결이 실패(sshProviderReady 캐시 제거됨)한 상태에서 다시 호출하면
 * 새 SSH 부트스트랩을 시작한다.
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

export function FilesPanel() {
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

  // For disconnected SSH workspaces, suppress all remote-reading panels so
  // no IPC call reaches getFs / getAgentChannel before the user connects.
  const showOffline =
    activeWorkspace?.location.kind === "ssh" && !workspaceOnline;

  // 재연결 진행 중 여부 — Reconnect 버튼을 disabled 처리하고 라벨을 변경하는 데 사용.
  const [isReconnecting, setIsReconnecting] = useState(false);

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
                    // Persistent mode pick → state.selected.* (not state.active.bg,
                    // which is the transient mouse-down overlay — design.md §8).
                    // aria-pressed supplies the redundant signal channel.
                    className={cn(
                      isActive &&
                        "bg-[var(--state-selected-bg)] text-[var(--state-selected-fg)]",
                    )}
                    onClick={() => setFilesPanelMode(activeWorkspace.id, mode)}
                  >
                    <Icon />
                  </Button>
                );
              })}
            </div>
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden">
              {showOffline ? (
                <EmptyState
                  title={t("panel.offline.title")}
                  description={t("panel.offline.description")}
                  tone="status"
                  actionLabel={isReconnecting ? t("panel.offline.reconnecting") : t("panel.offline.reconnect")}
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
                    <SearchPanel workspaceId={activeWorkspace.id} />
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
              ) : (
                <FileTree workspaceId={activeWorkspace.id} rootAbsPath={activeWorkspace.rootPath} />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="px-4 text-center text-app-ui-sm text-muted-foreground">
              {t("panel.noWorkspace").split("\n").map((line, i) => (
                i === 0 ? line : <><br key={i} />{line}</>
              ))}
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
}

function openGitDiffFromRow({
  workspaceId,
  groupKey,
  entry,
  preview,
}: GitPanelOpenDiffInput): void {
  const isUnborn =
    useGitStore.getState().sessions.get(workspaceId)?.status?.branch?.isUnborn ?? false;
  const refs = refsForGitGroup(groupKey, isUnborn);
  // preview 미지정 시 openDiffTab의 default(preview=true)에 위임 — 파일트리
  // single-click과 동일한 임시 슬롯 재사용 흐름. 더블클릭은 `preview=false`로
  // permanent 승격.
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
