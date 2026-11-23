// The status bar of a workspace on another computer: the local bar's parts
// for what that computer tells. Its name and that the workspace is only
// looked at lead; then the branch, ahead and behind its upstream (or "no
// git"), and the changes by state, which open Source Control.

import { GitBranch, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PeerGitStatus } from "../../services/remote/peer-git-status";
import {
  type PeerWorkspaceTarget,
  peerTargetId,
  usePeerWorkspaceStore,
} from "../../state/stores/peer-workspace";
import {
  branchLabel,
  ChangeCountsSegment,
  NoGitSegment,
  StatusBarItem,
} from "../workbench/status-bar-items";
import { peerGitCounts } from "./git-groups";
import { PeerDeviceIcon } from "./sidebar";

export function PeerStatusBar({
  target,
  status,
  gitError,
}: {
  target: PeerWorkspaceTarget;
  /** The last status read; none until the first, or where git cannot be read. */
  status: PeerGitStatus | undefined;
  gitError: string | undefined;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const branch = status
    ? status.branch === null
      ? t("peerWorkspace.gitDetached")
      : branchLabel(
          { current: status.branch, ahead: status.ahead, behind: status.behind, isUnborn: false },
          t,
        )
    : null;
  return (
    <div
      role="status"
      aria-label={t("statusBar.aria")}
      className="relative flex h-6 shrink-0 items-center select-none"
      style={{ color: "var(--status-bar-fg)" }}
    >
      <div className="flex min-w-0 flex-1 items-center">
        <StatusBarItem title={target.deviceName}>
          <PeerDeviceIcon platform={target.platform} className="size-3 shrink-0" />
          <span className="truncate max-w-40">{target.deviceName}</span>
        </StatusBarItem>
        <StatusBarItem className="shrink-0 text-[var(--state-warning-fg)]">
          <Lock className="size-3 shrink-0" aria-hidden="true" />
          <span>{t("peerWorkspace.readOnly")}</span>
        </StatusBarItem>
        {branch !== null ? (
          <StatusBarItem title={branch}>
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate max-w-40">{branch}</span>
          </StatusBarItem>
        ) : (
          gitError === "not-found" && <NoGitSegment />
        )}
        {status && (
          <ChangeCountsSegment
            counts={peerGitCounts(status.files)}
            note={status.truncated ? t("peerWorkspace.gitTruncated") : undefined}
            onOpen={() => usePeerWorkspaceStore.getState().setFilesMode(id, "git")}
          />
        )}
      </div>
    </div>
  );
}
