import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { ipcCallResult } from "../../ipc/client";
import { read } from "./commit-model";

export type PeerNoteRow = RpcResult<"notes.list">["notes"][number];
export type PeerNote = RpcResult<"notes.read">;

export const PEER_NOTES_REFRESH_MS = 20_000;

export function listPeerNotes({ deviceId, workspaceId }: PeerWorkspace, signal: AbortSignal) {
  return read(signal, () =>
    ipcCallResult("remote", "peerNotesList", { deviceId, workspaceId }, { signal }),
  );
}

export function readPeerNote(
  { deviceId, workspaceId }: PeerWorkspace,
  note: string,
  signal: AbortSignal,
) {
  return read(signal, () =>
    ipcCallResult("remote", "peerNotesRead", { deviceId, workspaceId, note }, { signal }),
  );
}
