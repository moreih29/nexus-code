import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { type IpcResult, ipcErr } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";

export type PeerCommit = RpcResult<"git.show">;
export type PeerCommitPatch = RpcResult<"git.diff">;

export async function read<T>(signal: AbortSignal, run: () => Promise<IpcResult<T>>) {
  signal.throwIfAborted();
  try {
    const result = await run();
    signal.throwIfAborted();
    return result;
  } catch {
    signal.throwIfAborted();
    return ipcErr("unavailable", "");
  }
}

export function readPeerCommit(
  { deviceId, workspaceId }: PeerWorkspace,
  hash: string,
  signal: AbortSignal,
) {
  return read(signal, () =>
    ipcCallResult("remote", "peerGitShow", { deviceId, workspaceId, hash }, { signal }),
  );
}

export function readPeerCommitPatch(
  { deviceId, workspaceId }: PeerWorkspace,
  commit: string,
  path: string,
  signal: AbortSignal,
) {
  return read(signal, () =>
    ipcCallResult("remote", "peerGitDiff", { deviceId, workspaceId, path, commit }, { signal }),
  );
}
