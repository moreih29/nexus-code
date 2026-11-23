import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { LogEntry } from "../../../shared/git/types";
import {
  EMPTY_PEER_VIEW,
  type PeerWorkspaceTarget,
  peerTabId,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import { HistoryList } from "../files/git/history/list";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { createPeerHistory, type PeerHistoryCommit } from "./history-model";
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
  const entries = useMemo(() => (commits ?? []).map(peerLogEntry), [commits]);
  const commitTabs = tabs.filter((tab) => tab.type === "peer.commit");
  const activeHash = commitTabs.find((tab) => peerTabId(tab) === activePath)?.hash ?? null;
  const [picked, setPicked] = useState<{ hash: string; over: string | null } | null>(null);
  const selectedSha = picked && picked.over === activeHash ? picked.hash : activeHash;

  function open(entry: LogEntry) {
    if (!canRead && !commitTabs.some((tab) => tab.hash === entry.sha)) return;
    openCommit(id, {
      hash: entry.sha,
      subject: entry.subject || t("editor.commit_title", { sha: entry.sha.slice(0, 7) }),
    });
  }

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
        <>
          {errorMessage && (
            <p role="status" className="shrink-0 px-2 py-1 text-app-ui-sm text-muted-foreground">
              {errorMessage}
            </p>
          )}
          <div className="min-h-0 flex-1" aria-busy={pending}>
            <HistoryList
              entries={entries}
              selectedSha={selectedSha}
              loading={pending}
              loadingMore={pending}
              hasMore={nextSkip !== null}
              onSelect={(entry) => setPicked({ hash: entry.sha, over: activeHash })}
              onOpen={open}
              onLoadMore={() => {
                if (canRead) void history.more();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function peerLogEntry(commit: PeerHistoryCommit): LogEntry {
  const at = new Date(commit.at);
  return {
    sha: commit.hash,
    parents: [],
    authorName: commit.author,
    authoredAt: Number.isNaN(at.getTime()) ? "" : at.toISOString(),
    subject: commit.subject,
  };
}
