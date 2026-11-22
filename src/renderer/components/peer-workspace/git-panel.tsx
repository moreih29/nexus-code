import { GitBranch, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isPeerGitConflict, type PeerGitSide } from "../../services/remote/peer-git-status";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { FileIcon } from "../files/file-tree/file-icon";
import { GitStatusBadge } from "../files/git/file-row/status-badge";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { peerGitDisplayPath } from "./git-path-label";
import { PeerReadOnlyBadge } from "./labels";

export function PeerGitPanel({
  target,
  canRead,
  updateNeeded,
  refresh,
}: {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  updateNeeded: boolean;
  refresh: () => void;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const { gitStatus, gitError, tabs } = usePeerWorkspaceStore(
    (state) => state.views[id] ?? EMPTY_PEER_VIEW,
  );
  const openDiff = usePeerWorkspaceStore((state) => state.openDiff);
  const upgrade = updateNeeded || gitError === "unsupported";
  const error = upgrade
    ? t("peerWorkspace.updateNeeded")
    : gitError === "not-found"
      ? t("peerWorkspace.gitNotRepository")
      : gitError === "permission-denied"
        ? t("peerWorkspace.accessDenied")
        : gitError
          ? t("peerWorkspace.connectionUnavailable")
          : null;
  const groups: readonly { side: PeerGitSide; label: string }[] = [
    { side: "staged", label: t("files:git.statusGroups.staged") },
    { side: "unstaged", label: t("peerWorkspace.gitUnstaged") },
  ];
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("files:git.panel.header.title")}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-1">
        <PeerReadOnlyBadge />
        <span className="min-w-0 flex-1 text-app-micro text-muted-foreground">
          · {t("peerWorkspace.gitNoStageCommit")}
        </span>
        <IconButton
          label={t("files:fileTree.header.refresh")}
          size="sm"
          disabled={!canRead || upgrade}
          onClick={refresh}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      {!gitStatus || upgrade ? (
        <EmptyState
          title={error ?? t(canRead ? "editor.loading" : "peerWorkspace.connectionUnavailable")}
          tone="status"
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
          <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-1 text-app-ui-sm">
            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate" title={gitStatus.branch ?? undefined}>
              {gitStatus.branch ?? t("peerWorkspace.gitDetached")}
            </span>
            {gitStatus.upstream && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate text-muted-foreground" title={gitStatus.upstream}>
                  {gitStatus.upstream}
                </span>
              </>
            )}
            <span
              className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground"
              role="img"
              aria-label={t("peerWorkspace.gitDivergence", {
                ahead: gitStatus.ahead,
                behind: gitStatus.behind,
              })}
            >
              ↑{gitStatus.ahead} ↓{gitStatus.behind}
            </span>
          </div>
          {(error || gitStatus.truncated) && (
            <div role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
              {error && <div>{error}</div>}
              {gitStatus.truncated && <div>{t("peerWorkspace.gitTruncated")}</div>}
            </div>
          )}
          {gitStatus.files.length === 0 && !gitStatus.truncated && (
            <EmptyState title={t("files:git.panel.noChanges.title")} tone="status" />
          )}
          {groups.map(({ side, label }) => {
            const files = gitStatus.files.filter((file) => file[side]);
            if (files.length === 0) return null;
            return (
              <details key={side} open>
                <summary className="cursor-pointer px-2 py-1 text-app-ui-sm text-muted-foreground hover:bg-[var(--state-hover-bg)]">
                  {label} <span className="rounded bg-muted px-1">{files.length}</span>
                </summary>
                {files.map((file) => {
                  const display = (path: string) => peerGitDisplayPath(target.workspace.path, path);
                  const { path, fileName: name, directory, outsideWorkspace } = display(file.path);
                  const old = file.oldPath ? display(file.oldPath) : null;
                  const scope = outsideWorkspace ? t("peerWorkspace.gitOutsideWorkspace") : null;
                  const oldScope = old?.outsideWorkspace
                    ? t("peerWorkspace.gitOutsideWorkspace")
                    : null;
                  const current = scope ? `${path} · ${scope}` : path;
                  const from = oldScope ? `${old?.path} · ${oldScope}` : old?.path;
                  const title = from ? `${from} → ${current}` : current;
                  const existing = tabs.some(
                    (tab) =>
                      tab.type === "peer.diff" && tab.path === file.path && tab.side === side,
                  );
                  return (
                    <button
                      key={file.path}
                      type="button"
                      title={title}
                      aria-label={title}
                      disabled={!canRead && !existing}
                      className="flex h-7 w-full items-center gap-1.5 px-2 pl-4 text-left text-app-body enabled:hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                      onClick={() => openDiff(id, file, side)}
                    >
                      <FileIcon
                        size="sm"
                        kind="file"
                        name={name}
                        tone="sidebar"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {old || outsideWorkspace ? (
                          title
                        ) : (
                          <>
                            {name} <span className="text-muted-foreground">{directory}</span>
                          </>
                        )}
                      </span>
                      <GitStatusBadge code={isPeerGitConflict(file) ? "!" : (file[side] ?? "")} />
                    </button>
                  );
                })}
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
