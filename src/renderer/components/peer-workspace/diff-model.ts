import type { DiffHunk, RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import { ipcCallResult } from "../../ipc/client";
import { beforeOfHunks } from "../../services/remote/file-comparison";
import { peerGitPaths } from "../../services/remote/peer-git-paths";
import {
  isPeerGitConflict,
  type PeerGitFile,
  type PeerGitSide,
} from "../../services/remote/peer-git-status";
import { type PeerText, readPeerWorkspaceText } from "../../services/remote/peer-workspace";
import type { PeerWorkspaceTarget } from "../../state/stores/peer-workspace";

type GitPatch = RpcResult<"git.diff">;

export type PeerDiffView =
  | { kind: "text"; before: string; after: string; oldPath?: string }
  | { kind: "patch"; patch: GitPatch; permissionDenied?: boolean }
  | { kind: "error"; error: string };

const hasFullPatch = (patch: GitPatch) => !patch.truncated && !patch.binary;

function beforeText(hunks: readonly DiffHunk[], now: string) {
  const exact = beforeOfHunks(hunks, now);
  if (exact !== null || !now.includes("\r\n") || /(?<!\r)\n/.test(now)) return exact;
  // Git may report LF while the working tree is checked out as CRLF.
  const before = beforeOfHunks(hunks, now.replaceAll("\r\n", "\n"));
  return before?.replace(/(?<!\r)\n/g, "\r\n") ?? null;
}

export function reconstructPeerDiff(
  change: PeerGitFile,
  side: PeerGitSide,
  patch: GitPatch,
  working: PeerText,
  unstaged?: GitPatch | null,
): PeerDiffView {
  const partial = { kind: "patch", patch } as const;
  if (
    !hasFullPatch(patch) ||
    isPeerGitConflict(change) ||
    working.kind !== "text" ||
    working.truncated
  )
    return partial;
  let after = working.text;
  if (side === "staged") {
    if (change.staged === "D") after = "";
    else if (unstaged || (unstaged === undefined && change.unstaged)) {
      if (!unstaged || !hasFullPatch(unstaged)) return partial;
      const index = beforeText(unstaged.hunks, after);
      if (index === null) return partial;
      after = index;
    }
  }

  const code = change[side];
  const before = beforeText(patch.hunks, after);
  if (before === null || (code === "?" && before !== "")) return partial;
  const oldPath = code === "R" || code === "C" ? (patch.oldPath ?? change.oldPath) : undefined;
  return { kind: "text", before: code === "A" ? "" : before, after, oldPath };
}

export async function loadPeerDiff(
  target: PeerWorkspaceTarget,
  change: PeerGitFile,
  side: PeerGitSide,
  signal: AbortSignal,
  topLevel?: string,
): Promise<PeerDiffView> {
  const denied: PeerDiffView = {
    kind: "patch",
    patch: { path: change.path, hunks: [] },
    permissionDenied: true,
  };
  const file = peerGitPaths(target.workspace.path, topLevel).toWorkspace(change.path);
  if (!file) return denied;
  const peer = { deviceId: target.deviceId, workspaceId: target.workspaceId };
  const args = { ...peer, path: change.path };
  const readPatch = (staged: boolean) =>
    ipcCallResult("remote", "peerGitDiff", { ...args, staged }, { signal });
  const reply = await readPatch(side === "staged");
  signal.throwIfAborted();
  if (!reply.ok) {
    return reply.kind === "permission-denied" ? denied : { kind: "error", error: reply.kind };
  }

  const patch = reply.value;
  const partial = { kind: "patch", patch } as const;
  const path = file.absolute;
  if (!path) return { ...partial, permissionDenied: true };
  if (!hasFullPatch(patch) || isPeerGitConflict(change)) return partial;
  try {
    const stagedDeletion = side === "staged" && change.staged === "D";
    let unstaged: GitPatch | null | undefined;
    if (side === "staged") {
      const reply = await readPatch(false);
      signal.throwIfAborted();
      if (!reply.ok && reply.kind !== "not-found") return partial;
      unstaged = reply.ok ? reply.value : null;
      if (!stagedDeletion && unstaged && !hasFullPatch(unstaged)) return partial;
    }
    const deletion =
      stagedDeletion ||
      (side === "unstaged"
        ? change.unstaged === "D"
        : unstaged?.hunks.some((hunk) => hunk.newStart === 0 && hunk.newLines === 0));
    const working: PeerText = deletion
      ? { kind: "text", text: "" }
      : (await readPeerWorkspaceText(peer, path, signal, { fullOnly: true })).text;
    signal.throwIfAborted();
    return reconstructPeerDiff(change, side, patch, working, unstaged);
  } catch {
    signal.throwIfAborted();
    return partial;
  }
}
