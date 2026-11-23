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

type NoteMethod = "notes.read" | "notes.transcript";

export type AskNotes = <M extends NoteMethod>(
  method: M,
  params: RpcParams<M>,
) => Promise<RpcResult<M>>;

type NoteTranscript = RpcResult<"notes.transcript">;
type WholeRecording = Omit<
  NoteTranscript["recordings"][number],
  "start" | "total" | "base" | "revision"
>;

type ReadParams = Omit<
  RpcParams<"notes.read">,
  "from" | "withoutTranscript" | "markdownStart" | "markdownLimit"
>;
type TranscriptParams = Omit<RpcParams<"notes.transcript">, "from" | "start" | "limit">;

export const MAX_NOTE_READS = 3;

class ChangedWhileRead extends Error {}

async function again<T>(read: () => Promise<T>, what: string): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof ChangedWhileRead)) throw error;
      if (tries >= MAX_NOTE_READS) {
        throw new Error(`${what} kept changing while it was read; try again`);
      }
    }
  }
}

function wholeRecording(
  ask: AskNotes,
  workspaceId: string,
  note: string,
  recording: string,
): Promise<{ id: string; title: string; recording: WholeRecording; revision?: string }> {
  return again(async () => {
    const first = await ask("notes.transcript", { workspaceId, note, recording, start: 0 });
    const head = first.recordings[0];
    if (!head) throw new Error(`no recording ${recording} in the answer`);
    const { start: _start, total, base: _base, revision, ...rest } = head;
    const lines = [...rest.lines];
    const seen = new Set(lines.map((line) => line.id));
    let last = total;
    let held = revision;
    while (lines.length < (last ?? lines.length)) {
      const page = await ask("notes.transcript", {
        workspaceId,
        note: first.id,
        recording: head.id,
        start: lines.length,
      });
      const got = page.recordings[0];
      if (!got) throw new Error(`no recording ${recording} in the answer`);
      if (
        got.start !== lines.length ||
        (got.total !== undefined && last !== undefined && got.total < last) ||
        (got.base !== undefined && held !== undefined && got.base !== held) ||
        got.lines.some((line) => seen.has(line.id))
      ) {
        throw new ChangedWhileRead();
      }
      if (!got.lines.length) {
        if (got.total === undefined || got.total <= lines.length) break;
        throw new ChangedWhileRead();
      }
      for (const line of got.lines) seen.add(line.id);
      lines.push(...got.lines);
      last = got.total;
      held = got.revision;
    }
    return { id: first.id, title: first.title, recording: { ...rest, lines }, revision: held };
  }, "the recording");
}

async function noteBody(
  ask: AskNotes,
  params: Omit<ReadParams, "transcriptOnly">,
  whole: boolean,
): Promise<RpcResult<"notes.read">> {
  if (!whole) {
    return ask("notes.read", {
      ...params,
      withoutTranscript: true,
      markdownStart: 0,
      markdownLimit: 1,
    });
  }
  return again(async () => {
    const first = await ask("notes.read", { ...params, withoutTranscript: true, markdownStart: 0 });
    let markdown = first.markdown;
    const total = first.markdownTotal ?? markdown.length;
    while (markdown.length < total) {
      const page = await ask("notes.read", {
        ...params,
        note: first.id,
        withoutTranscript: true,
        markdownStart: markdown.length,
      });
      if (
        page.updatedAt !== first.updatedAt ||
        page.markdownTotal !== first.markdownTotal ||
        page.markdownStart !== markdown.length ||
        !page.markdown
      ) {
        throw new ChangedWhileRead();
      }
      markdown += page.markdown;
    }
    return { ...first, markdown };
  }, "the note");
}

export async function readWholeNote(
  ask: AskNotes,
  schema: string | undefined,
  params: ReadParams,
): Promise<RpcResult<"notes.read">> {
  if (!speaks(schema, NOTE_PAGES_SCHEMA)) return ask("notes.read", params);
  const { transcriptOnly, ...rest } = params;
  const note = await noteBody(ask, rest, !transcriptOnly);
  let recordings = note.recordings ?? [];
  const read: (CliTranscriptRecording & { id: string })[] = [];
  const revisions: (string | undefined)[] = [];
  for (const info of recordings) {
    const whole = await wholeRecording(ask, params.workspaceId, note.id, info.id);
    read.push({
      id: info.id,
      startedAt: info.startedAt,
      ms: info.ms,
      lines: whole.recording.lines,
    });
    revisions.push(whole.revision);
  }
  const stale = (i: number) => {
    const info = recordings[i];
    const revision = revisions[i];
    return (
      read[i]?.lines.length !== info?.lines ||
      (revision !== undefined && info?.revision !== undefined && revision !== info.revision)
    );
  };
  if (read.some((_rec, i) => stale(i))) {
    const fresh = await noteBody(ask, { ...rest, note: note.id }, false);
    recordings = recordings.map(
      (info) => fresh.recordings?.find((now) => now.id === info.id) ?? info,
    );
    for (const rec of read) {
      rec.ms = recordings.find((info) => info.id === rec.id)?.ms ?? rec.ms;
    }
  }
  return {
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    markdown: transcriptOnly ? "" : note.markdown,
    transcript: transcriptOnly || read.length ? cliTranscriptMarkdown(note.title, read) : "",
    recordings,
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
  const found = await noteBody(ask, { workspaceId, note }, false);
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
