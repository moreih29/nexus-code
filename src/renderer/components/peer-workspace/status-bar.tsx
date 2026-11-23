import { GitBranch, Lock } from "lucide-react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RoomPeer } from "../../../shared/remote/room";
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
import { STATS_MIN_WIDTH, useWiderThan } from "../workbench/system-stats";
import { peerGitCounts } from "./git-groups";
import { PeerDeviceIcon } from "./sidebar";
import { PeerSystemStatsSegment } from "./system-stats";

export function PeerStatusBar({
  target,
  status,
  gitError,
  peer,
  active = false,
}: {
  target: PeerWorkspaceTarget;
  status: PeerGitStatus | undefined;
  gitError: string | undefined;
  peer?: RoomPeer;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const id = peerTargetId(target);
  const barRef = useRef<HTMLDivElement>(null);
  const roomForStats = useWiderThan(barRef, STATS_MIN_WIDTH);
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
      ref={barRef}
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
      <div className="flex items-center shrink-0 whitespace-nowrap">
        {roomForStats && <PeerSystemStatsSegment target={target} peer={peer} active={active} />}
      </div>
    </div>
  );
}
