import type { RpcResult } from "../../../../packages/remote-protocol/src/rpc";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import type { PeerNoteRead } from "../../../shared/ipc/contract";
import {
  type ReadTranscriptRecording,
  readTranscriptRecording,
  transcriptFromMarkdown,
} from "../../../shared/notes/transcript";
import { ipcCallResult } from "../../ipc/client";
import type { TranscriptReading } from "../notes/transcript-panel";
import { read } from "./commit-model";

export type PeerNoteRow = RpcResult<"notes.list">["notes"][number];
export type PeerNote = PeerNoteRead;

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

export function peerTranscript(
  note: Pick<PeerNote, "transcript" | "transcriptRecordings">,
): TranscriptReading {
  const read: readonly ReadTranscriptRecording[] =
    note.transcriptRecordings ?? transcriptFromMarkdown(note.transcript);
  return {
    recordings: read.map(readTranscriptRecording),
    lengthMs: Object.fromEntries(read.map((recording) => [recording.id, recording.ms])),
  };
}
