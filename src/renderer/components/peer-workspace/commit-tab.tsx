import { ChevronRight } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import type { IpcResult } from "../../../shared/ipc/result";
import { type PeerCommitTab, peerTabId } from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { GitStatusBadge } from "../files/git/file-row/status-badge";
import { EmptyState } from "../ui/empty-state";
import {
  type PeerCommit,
  type PeerCommitPatch,
  readPeerCommit,
  readPeerCommitPatch,
} from "./commit-model";
import { PeerCommitTime } from "./commit-time";
import { PeerReadOnlyBadge } from "./labels";
import { PeerPatchView } from "./patch-view";
import { peerSearchErrorKey } from "./search-model";

/** Commit IDs are immutable, so successful reads survive hiding or reconnecting. */
function useCommitRead<T>(
  enabled: boolean,
  rejoin: number,
  read: (signal: AbortSignal) => Promise<IpcResult<T>>,
) {
  const [result, setResult] = useState<IpcResult<T> | null>(null);
  const attempt = useEffectEvent((signal: AbortSignal) => {
    if (result?.ok) return;
    // The reader wraps transport errors in a result and rejects on cancellation.
    void read(signal).then(
      (next) => {
        if (!signal.aborted) setResult(next);
      },
      () => {},
    );
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry failed reads on reconnect
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    attempt(controller.signal);
    return () => controller.abort();
  }, [enabled, rejoin]);
  return result;
}

export function PeerCommitTabBody({
  target,
  tab,
  selected,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspace;
  tab: PeerCommitTab;
  selected: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const show = canRead && selected;
  const result = useCommitRead(show, rejoin, (signal) => readPeerCommit(target, tab.hash, signal));
  const detail = result?.ok ? result.value : null;
  const short = tab.hash.slice(0, 7);
  const subject = (detail?.subject ?? tab.subject) || t("editor.commit_title", { sha: short });
  const error = updateNeeded
    ? t("peerWorkspace.updateNeeded")
    : result && !result.ok
      ? result.kind === "not-found"
        ? t("peerWorkspace.gitCommitMissing")
        : t(peerSearchErrorKey(result.kind))
      : null;

  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(peerTabId(tab))}
      className={cn("min-h-0 flex-1 flex-col", selected ? "flex" : "hidden")}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-app-body-emphasis" title={subject}>
          {subject}
        </h2>
        <code className="text-app-ui-sm text-muted-foreground" title={tab.hash}>
          {short}
        </code>
        <PeerReadOnlyBadge />
      </div>
      {error || !detail ? (
        <EmptyState
          title={error ?? t(show ? "editor.loading_commit" : "peerWorkspace.connectionUnavailable")}
          tone="status"
          className="flex-1"
        />
      ) : (
        <PeerCommitDetails detail={detail} target={target} canRead={show} rejoin={rejoin} />
      )}
    </Tabs.Content>
  );
}

export function PeerCommitDetails({
  detail,
  target,
  canRead,
  rejoin,
}: {
  detail: PeerCommit;
  target: PeerWorkspace;
  canRead: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="app-scrollbar min-h-0 flex-1 overflow-auto p-3 text-app-ui-sm">
      <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <span>{detail.author}</span>
        <span aria-hidden="true">·</span>
        <PeerCommitTime at={detail.at} detailed />
      </p>
      {detail.body && (
        <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-border bg-muted p-2 font-sans">
          {detail.body}
        </pre>
      )}
      <div className="mt-4">
        <h3 className="mb-1 text-app-body-emphasis">
          {t("editor.files_changed", { count: detail.files.length })}
        </h3>
        {detail.truncated && (
          <p role="status" className="mb-1 text-[var(--state-warning-fg)]">
            {t("peerWorkspace.gitTruncated")}
          </p>
        )}
        {detail.files.length === 0 && !detail.truncated && (
          <p className="text-muted-foreground">{t("editor.no_file_changes")}</p>
        )}
        <ul className="flex flex-col gap-1">
          {detail.files.map((file, index) => (
            <PeerCommitFile
              key={file.path}
              target={target}
              commit={detail.hash}
              file={file}
              initialOpen={index === 0}
              canRead={canRead}
              rejoin={rejoin}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

function PeerCommitFile({
  target,
  commit,
  file,
  initialOpen,
  canRead,
  rejoin,
}: {
  target: PeerWorkspace;
  commit: string;
  file: PeerCommit["files"][number];
  initialOpen: boolean;
  canRead: boolean;
  rejoin: number;
}) {
  const [expanded, setExpanded] = useState(initialOpen);
  const patch = useCommitRead(canRead && expanded, rejoin, (signal) =>
    readPeerCommitPatch(target, commit, file.path, signal),
  );
  const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  return (
    <li className="min-w-0 rounded border border-border">
      <button
        type="button"
        aria-expanded={expanded}
        title={title}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex w-full min-w-0 items-center gap-1.5 bg-muted px-2 py-1 text-left hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 shrink-0", expanded && "rotate-90")}
        />
        <GitStatusBadge code={file.status} />
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </button>
      {expanded && <PeerCommitFilePatch result={patch} canRead={canRead} />}
    </li>
  );
}

export function PeerCommitFilePatch({
  result,
  canRead,
}: {
  result: IpcResult<PeerCommitPatch> | null;
  canRead: boolean;
}) {
  const { t } = useTranslation();
  if (!result?.ok) {
    const key = result
      ? result.kind === "not-found"
        ? "peerWorkspace.gitChangeMissing"
        : peerSearchErrorKey(result.kind)
      : canRead
        ? "editor.loading_diff"
        : "peerWorkspace.connectionUnavailable";
    return (
      <p role="status" className="px-2 py-1 text-muted-foreground">
        {t(key)}
      </p>
    );
  }
  const { binary, truncated, hunks } = result.value;
  return <PeerPatchView hunks={hunks} binary={binary} truncated={truncated} embedded />;
}
