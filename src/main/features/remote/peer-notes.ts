import {
  NOTE_PAGES_SCHEMA,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import {
  type CliTranscriptRecording,
  cliTranscriptMarkdown,
} from "../../../shared/notes/transcript";
import { speaks } from "../../../shared/remote/room";
import type { RemoteRoom } from "./room";

export type PeerNoteRoom = Pick<RemoteRoom, "request"> & Partial<Pick<RemoteRoom, "state">>;

type ReadParams = Omit<RpcParams<"notes.read">, "from" | "transcriptOnly" | "withoutTranscript">;

export async function readWholePeerNote(
  room: PeerNoteRoom,
  deviceId: string,
  params: ReadParams,
  signal?: AbortSignal,
): Promise<RpcResult<"notes.read">> {
  const schema = room.state?.().peers.find((peer) => peer.id === deviceId)?.schema;
  if (!speaks(schema, NOTE_PAGES_SCHEMA)) {
    return room.request(deviceId, "notes.read", params, undefined, signal);
  }
  const note = await room.request(
    deviceId,
    "notes.read",
    { ...params, withoutTranscript: true },
    undefined,
    signal,
  );
  const recordings = note.recordings ?? [];
  if (!recordings.length) return note;
  const read: CliTranscriptRecording[] = [];
  for (const recording of recordings) {
    const lines: CliTranscriptRecording["lines"][number][] = [];
    for (;;) {
      const page = await room.request(
        deviceId,
        "notes.transcript",
        {
          workspaceId: params.workspaceId,
          note: note.id,
          recording: recording.id,
          start: lines.length,
        },
        undefined,
        signal,
      );
      const got = page.recordings[0];
      if (!got?.lines.length) break;
      lines.push(...got.lines);
      if (lines.length >= (got.total ?? lines.length)) break;
    }
    read.push({ startedAt: recording.startedAt, ms: recording.ms, lines });
  }
  return { ...note, transcript: cliTranscriptMarkdown(note.title, read) };
}
