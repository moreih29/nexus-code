import { useMonaco } from "@monaco-editor/react";
import { ArrowRight } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useEffectEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PeerGitFile } from "../../services/remote/peer-git-status";
import {
  type PeerDiffTab,
  type PeerWorkspaceTarget,
  peerTabId,
} from "../../state/stores/peer-workspace";
import { cn } from "../../utils/cn";
import { ReadOnlyDiffEditor } from "../editor/read-only-diff-editor";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { loadPeerDiff, type PeerDiffView } from "./diff-model";
import { peerGitDisplayPath } from "./git-path-label";
import { PeerReadOnlyBadge } from "./labels";
import { PeerPatchView } from "./patch-view";
import { peerSearchErrorKey } from "./search-model";

export function PeerDiffTabBody({
  target,
  tab,
  latest,
  topLevel,
  selected,
  canRead,
  updateNeeded,
  rejoin,
}: {
  target: PeerWorkspaceTarget;
  tab: PeerDiffTab;
  latest?: PeerGitFile;
  topLevel?: string;
  selected: boolean;
  canRead: boolean;
  updateNeeded: boolean;
  rejoin: number;
}) {
  const { t } = useTranslation();
  const monaco = useMonaco();
  const [view, setView] = useState<PeerDiffView | null>(null);
  const [revision, setRevision] = useState(0);
  const read = useEffectEvent((signal: AbortSignal) =>
    loadPeerDiff(target, latest ?? tab, tab.side, signal, topLevel),
  );
  const root = target.workspace.path;
  const show = canRead && selected;
  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect, reopen and manual refresh start a new read
  useEffect(() => {
    if (!show) return;
    const controller = new AbortController();
    const { signal } = controller;
    void read(signal)
      .then((next) => {
        if (!signal.aborted) setView(next);
      })
      .catch(() => {
        if (!signal.aborted) setView({ kind: "error", error: "unavailable" });
      });
    return () => controller.abort();
  }, [show, root, topLevel, rejoin, revision, tab]);

  const stage = tab.side === "staged";
  const leftRef = stage ? "HEAD" : "INDEX";
  const rightRef = stage ? "INDEX" : "WORKING";
  const change = latest ?? tab;
  const renamed = change[tab.side] === "R" || change[tab.side] === "C";
  const left =
    view?.kind === "text"
      ? (view.oldPath ?? tab.path)
      : ((renamed ? change.oldPath : undefined) ?? tab.path);
  const describe = (path: string) => peerGitDisplayPath(root, path, topLevel);
  const display = (file: ReturnType<typeof describe>) => {
    return file.outsideWorkspace
      ? `${file.path} · ${t("peerWorkspace.gitOutsideWorkspace")}`
      : file.path;
  };
  const leftPath = t("peerWorkspace.gitDiffLeft", { path: display(describe(left)), ref: leftRef });
  const right = describe(tab.path);
  const rightPath = t("peerWorkspace.gitDiffRight", { path: display(right), ref: rightRef });
  const error = updateNeeded
    ? t("peerWorkspace.updateNeeded")
    : view?.kind === "error"
      ? t(
          view.error === "not-found"
            ? "peerWorkspace.gitChangeMissing"
            : peerSearchErrorKey(view.error),
        )
      : null;
  return (
    <Tabs.Content
      forceMount
      value={encodeURIComponent(peerTabId(tab))}
      className={cn("min-h-0 flex-1 flex-col", selected ? "flex" : "hidden")}
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border/50 px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-app-ui-sm text-muted-foreground">
          <span className="min-w-0 truncate" title={leftPath}>
            {leftPath}
          </span>
          <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate" title={rightPath}>
            {rightPath}
          </span>
        </div>
        <PeerReadOnlyBadge />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!show || (view?.kind === "error" && view.error === "unsupported")}
          onClick={() => setRevision((before) => before + 1)}
        >
          {t("editor.reload")}
        </Button>
      </div>
      {error ? (
        <EmptyState title={error} tone="status" className="flex-1" />
      ) : view?.kind === "patch" ? (
        <PeerPatchView
          hunks={view.patch.hunks}
          binary={view.patch.binary}
          permissionDenied={view.permissionDenied}
          truncated={view.patch.truncated}
        />
      ) : view?.kind === "text" && monaco && selected ? (
        <div className="min-h-0 flex-1">
          <ReadOnlyDiffEditor
            monaco={monaco}
            path={right.path}
            before={view.before}
            now={view.after}
            sideBySide
            hideGutterActions
          />
        </div>
      ) : (
        <EmptyState
          title={t(view || show ? "editor.loading_diff" : "peerWorkspace.connectionUnavailable")}
          tone="status"
          className="flex-1"
        />
      )}
    </Tabs.Content>
  );
}
