import {
  NOTE_PAGES_SCHEMA,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { cliTranscriptMarkdown } from "../../../shared/notes/transcript";
import { speaks } from "../../../shared/remote/room";
import type { RemoteRoom } from "./room";

export type PeerNoteRoom = Pick<RemoteRoom, "request"> & Partial<Pick<RemoteRoom, "state">>;

type NoteMethod = "notes.read" | "notes.transcript";

export type AskNotes = <M extends NoteMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;

type NoteTranscript = RpcResult<"notes.transcript">;
type WholeRecording = Omit<NoteTranscript["recordings"][number], "start" | "total">;

type ReadParams = Omit<RpcParams<"notes.read">, "from" | "withoutTranscript">;
type TranscriptParams = Omit<RpcParams<"notes.transcript">, "from" | "start" | "limit">;

async function wholeRecording(
  ask: AskNotes,
  workspaceId: string,
  note: string,
  recording: string,
): Promise<{ id: string; title: string; recording: WholeRecording }> {
  const first = await ask("notes.transcript", { workspaceId, note, recording, start: 0 });
  const head = first.recordings[0];
  if (!head) throw new Error(`no recording ${recording} in the answer`);
  const { start: _start, total, ...rest } = head;
  const lines = [...rest.lines];
  let last = total;
  while (lines.length < (last ?? lines.length)) {
    const page = await ask("notes.transcript", {
      workspaceId,
      note: first.id,
      recording: head.id,
      start: lines.length,
    });
    const got = page.recordings[0];
    if (!got?.lines.length) break;
    lines.push(...got.lines);
    last = got.total;
  }
  return { id: first.id, title: first.title, recording: { ...rest, lines } };
}

export async function readWholeNote(
  ask: AskNotes,
  schema: string | undefined,
  params: ReadParams,
): Promise<RpcResult<"notes.read">> {
  if (!speaks(schema, NOTE_PAGES_SCHEMA)) return ask("notes.read", params);
  const { transcriptOnly, ...rest } = params;
  const note = await ask("notes.read", { ...rest, withoutTranscript: true });
  const recordings = note.recordings ?? [];
  const read = [];
  for (const info of recordings) {
    const { recording } = await wholeRecording(ask, params.workspaceId, note.id, info.id);
    read.push({ startedAt: info.startedAt, ms: info.ms, lines: recording.lines });
  }
  return {
    ...note,
    markdown: transcriptOnly ? "" : note.markdown,
    transcript: transcriptOnly || read.length ? cliTranscriptMarkdown(note.title, read) : "",
  };
}

export async function readWholeTranscript(
  ask: AskNotes,
  schema: string | undefined,
  params: TranscriptParams,
): Promise<NoteTranscript> {
  if (!speaks(schema, NOTE_PAGES_SCHEMA)) return ask("notes.transcript", params);
  const { workspaceId, note, recording } = params;
  if (recording !== undefined) {
    const one = await wholeRecording(ask, workspaceId, note, recording);
    return { id: one.id, title: one.title, recordings: [one.recording] };
  }
  const found = await ask("notes.read", { workspaceId, note, withoutTranscript: true });
  const recordings: WholeRecording[] = [];
  for (const info of found.recordings ?? []) {
    recordings.push((await wholeRecording(ask, workspaceId, found.id, info.id)).recording);
  }
  return { id: found.id, title: found.title, recordings };
}

export function readWholePeerNote(
  room: PeerNoteRoom,
  deviceId: string,
  params: Omit<ReadParams, "transcriptOnly">,
  signal?: AbortSignal,
): Promise<RpcResult<"notes.read">> {
  const schema = room.state?.().peers.find((peer) => peer.id === deviceId)?.schema;
  return readWholeNote(
    (method, request) => room.request(deviceId, method, request, undefined, signal),
    schema,
    params,
  );
}
