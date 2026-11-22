import { RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { PeerCommitTime } from "./commit-time";
import { createPeerHistory } from "./history-model";
import { PeerReadOnlyBadge } from "./labels";
import { peerSearchErrorKey } from "./search-model";

export function PeerGitHistory({
  target,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const [history] = useState(() => createPeerHistory(target));
  const { commits, error, nextSkip, pending } = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const id = peerTargetId(target);
  const { tabs, activePath } = usePeerWorkspaceStore((state) => state.views[id] ?? EMPTY_PEER_VIEW);
  const openCommit = usePeerWorkspaceStore((state) => state.openCommit);

  useEffect(() => {
    if (!canRead || updateNeeded) return;
    void history.resume(rejoin);
    return history.pause;
  }, [canRead, history, rejoin, updateNeeded]);

  const upgrade = updateNeeded || error === "unsupported";
  const errorMessage = upgrade
    ? t("peerWorkspace.updateNeeded")
    : error
      ? t(error === "not-found" ? "peerWorkspace.gitNotRepository" : peerSearchErrorKey(error))
      : null;
  const shown = !upgrade && commits !== null;
  const existing = new Set(tabs.filter((tab) => tab.type === "peer.commit").map((tab) => tab.hash));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1.5 border-b border-border/50 px-2 py-1">
        <PeerReadOnlyBadge />
        <IconButton
          label={t("files:git.history.refSwitcher.refresh")}
          size="sm"
          disabled={!canRead || upgrade}
          onClick={() => void history.refresh()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </IconButton>
      </div>
      {!shown ? (
        <EmptyState
          title={
            errorMessage ??
            t(canRead ? "files:git.history.list.loading" : "peerWorkspace.connectionUnavailable")
          }
          tone="status"
        />
      ) : (
        <div className="app-scrollbar min-h-0 flex-1 overflow-auto">
          {errorMessage && (
            <p role="status" className="px-2 py-1 text-app-ui-sm text-muted-foreground">
              {errorMessage}
            </p>
          )}
          {commits.length === 0 && (
            <EmptyState title={t("peerWorkspace.gitNoCommits")} tone="status" />
          )}
          <ul aria-label={t("files:git.history.list.ariaLabel")} aria-busy={pending}>
            {commits.map((commit) => {
              const hash = commit.hash.slice(0, 7);
              const subject = commit.subject || t("editor.commit_title", { sha: hash });
              const selected = activePath === peerTabId({ type: "peer.commit", ...commit });
              return (
                <li key={commit.hash}>
                  <button
                    type="button"
                    className={cn(
                      "block w-full border-l-2 border-l-transparent px-2 py-1 text-left enabled:hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
                      selected &&
                        "border-l-[var(--state-selected-indicator)] bg-[var(--sidebar-item-selected-bg)]",
                    )}
                    aria-current={selected ? "true" : undefined}
                    disabled={!canRead && !existing.has(commit.hash)}
                    onClick={() => openCommit(id, commit)}
                  >
                    <span className="block truncate text-app-ui-sm" title={subject}>
                      {subject}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 text-app-micro text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate" title={commit.author}>
                        {commit.author}
                      </span>
                      <PeerCommitTime at={commit.at} />
                      <span className="font-mono" title={commit.hash}>
                        {hash}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {nextSkip !== null && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="w-full"
              disabled={!canRead || pending}
              onClick={() => void history.more()}
            >
              {t(pending ? "files:git.history.list.loading2" : "files:git.history.list.loadMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
