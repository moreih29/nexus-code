/**
 * A worktree's facts on another computer, unfolded under its header in the
 * agent list's task view: its folder and the first of its changed files,
 * as the local list draws them. The files are what git.status tells, read
 * only while unfolded and in reach. Lines added and deleted, and how far a
 * task is from its workspace's branch, are not told by that computer.
 */
import { useEffect, useState } from "react";
import type { RemoteWorkspace } from "../../../../packages/remote-protocol/src/rpc";
import { type PeerGitFile, readPeerGitStatus } from "../../services/remote/peer-git-status";
import { TaskInfoLines } from "../agent-list/task-info";

/** How many changed files show before "N more", as locally. */
const FILES_SHOWN = 5;

/** A file's letter as the local list tells it: the staged state, else the working one. */
export function peerChangeCode({ staged, unstaged }: PeerGitFile): string {
  return staged ?? unstaged ?? "M";
}

export function PeerTaskInfo({
  deviceId,
  workspace,
  canRead,
  onOpenFile,
  onShowChanges,
}: {
  deviceId: string;
  workspace: RemoteWorkspace;
  /** In reach, and that computer serves git. */
  canRead: boolean;
  onOpenFile: (file: PeerGitFile) => void;
  onShowChanges: () => void;
}) {
  const [files, setFiles] = useState<readonly PeerGitFile[] | undefined>(undefined);
  const workspaceId = workspace.id;
  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void readPeerGitStatus({ deviceId, workspaceId }, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted && result.ok) setFiles(result.value.files);
      },
      () => {},
    );
    return () => controller.abort();
  }, [canRead, deviceId, workspaceId]);

  const { path, git } = workspace;
  const isRoot = workspace.parentId === undefined;
  return (
    <TaskInfoLines
      label={isRoot && git?.branch ? `${git.branch} · ${path}` : path}
      path={path}
      files={files?.slice(0, FILES_SHOWN).map((file) => ({
        relPath: file.path,
        code: peerChangeCode(file),
      }))}
      count={files?.length ?? 0}
      onOpenFile={(relPath) => {
        const file = files?.find((item) => item.path === relPath);
        if (file) onOpenFile(file);
      }}
      onShowChanges={onShowChanges}
      testId="peer-agent-list-task-info"
    />
  );
}
