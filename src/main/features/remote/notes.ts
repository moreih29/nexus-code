import {
  MAX_ATTACHMENT_BYTES,
  MAX_LISTED_NOTES,
  MAX_TRANSCRIPT_LINES,
  type NoteRecordingInfo,
  type RemoteRecording,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import {
  recordingMs,
  type TranscriptRecording,
  transcriptLinesForCli,
  transcriptMarkdown,
} from "../../../shared/notes/transcript";
import { type CliServices, pick } from "../cli/context";
import { noteMarkdown } from "../notes/store";
import { RpcFailure } from "./room";
import { fitsAsResult, workspaceOf } from "./serving/common";

const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type NotePhotoExtension = (typeof EXTENSIONS)[keyof typeof EXTENSIONS];

export interface RemoteNotes {
  list(workspaceId: string): Promise<
    readonly {
      id: string;
      title: string;
      updatedAt: number;
      recording?: { recordings: number };
    }[]
  >;
  attach(
    workspaceId: string,
    noteId: string,
    bytes: Uint8Array,
    ext: NotePhotoExtension,
    name?: string,
  ): Promise<{ src: string }>;
  recording(): RemoteRecording | undefined;
}

function failure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not-found" || /^no workspace /.test(message)) {
    throw new RpcFailure(RpcErrorCode.NotFound, message);
  }
  if (code === "bad-request") throw new RpcFailure(RpcErrorCode.InvalidParams, message);
  throw new RpcFailure(RpcErrorCode.Unavailable, message);
}

export function looksLike(bytes: Uint8Array, mediaType: keyof typeof EXTENSIONS): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  switch (mediaType) {
    case "image/png":
      return bytes[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "image/gif":
      return ascii(0, 4) === "GIF8";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  }
}

export async function listNotes(
  notes: RemoteNotes,
  { workspaceId }: RpcParams<"notes.list">,
): Promise<RpcResult<"notes.list">> {
  const all = await notes.list(workspaceId).catch(failure);
  return {
    notes: all.slice(0, MAX_LISTED_NOTES).map(({ id, title, updatedAt, recording }) => ({
      id,
      title,
      updatedAt,
      recordings: recording?.recordings ?? 0,
    })),
  };
}

function picked<T>(
  items: readonly T[],
  selector: string,
  id: (item: T) => string,
  name: (item: T) => string,
  what: string,
): T {
  try {
    return pick(items, selector, id, name, what);
  } catch (error) {
    throw new RpcFailure(RpcErrorCode.NotFound, (error as Error).message);
  }
}

export async function findNote(services: CliServices, workspaceId: string, selector: string) {
  if (!workspaceOf(services, workspaceId))
    throw new RpcFailure(RpcErrorCode.NotFound, "no such workspace");
  const notes = await services.notes.list(workspaceId).catch(failure);
  const { id } = picked(
    notes,
    selector,
    (n) => n.id,
    (n) => n.title,
    "note",
  );
  return services.notes.read(workspaceId, id).catch(failure);
}

export function boundedNoteResult<T>(
  result: T,
  message = "the note is too large to send in one response; read it on that computer",
): T {
  if (!fitsAsResult(result)) throw new RpcFailure(RpcErrorCode.Unavailable, message);
  return result;
}

function recordingInfo(recording: TranscriptRecording): NoteRecordingInfo {
  return {
    id: recording.id,
    startedAt: recording.startedAt,
    ms: recordingMs(recording),
    lines: recording.lines.length,
    participants: recording.participantCount ?? "auto",
  };
}

export async function readNote(
  services: CliServices,
  { workspaceId, note: selector, transcriptOnly, withoutTranscript }: RpcParams<"notes.read">,
): Promise<RpcResult<"notes.read">> {
  if (transcriptOnly && withoutTranscript) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "transcriptOnly and withoutTranscript cannot both be set",
    );
  }
  const note = await findNote(services, workspaceId, selector);
  const { id, title, updatedAt } = note;
  const file =
    transcriptOnly || note.recording
      ? await services.notes.transcript(workspaceId, id).catch(failure)
      : undefined;
  const transcript = file && !withoutTranscript ? transcriptMarkdown(file, title) : "";
  return boundedNoteResult(
    {
      id,
      title,
      updatedAt,
      markdown: transcriptOnly ? "" : noteMarkdown(note),
      transcript,
      recordings: file?.recordings.map(recordingInfo) ?? [],
    },
    transcript
      ? "the note is too large to send in one response; read it without its transcript (withoutTranscript) and its recordings with notes.transcript a page at a time"
      : undefined,
  );
}

type TranscriptPage = RpcResult<"notes.transcript">["recordings"][number];

function fittedPage(
  head: Omit<RpcResult<"notes.transcript">, "recordings">,
  page: TranscriptPage,
): TranscriptPage {
  const fits = (count: number) =>
    fitsAsResult({ ...head, recordings: [{ ...page, lines: page.lines.slice(0, count) }] });
  if (fits(page.lines.length)) return page;
  let low = 0;
  let high = page.lines.length;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (fits(mid)) low = mid;
    else high = mid;
  }
  if (low === 0) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "a line of the transcript is too large to send; read it on that computer",
    );
  }
  return { ...page, lines: page.lines.slice(0, low) };
}

export async function noteTranscript(
  services: CliServices,
  { workspaceId, note: selector, recording, start, limit }: RpcParams<"notes.transcript">,
): Promise<RpcResult<"notes.transcript">> {
  const paged = start !== undefined || limit !== undefined;
  if (paged && recording === undefined) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "start and limit read one recording: name it with recording",
    );
  }
  const { id, title } = await findNote(services, workspaceId, selector);
  const { recordings } = await services.notes.transcript(workspaceId, id).catch(failure);
  const chosen =
    recording === undefined
      ? recordings
      : [
          picked(
            recordings,
            recording,
            (r) => r.id,
            (r) => r.id,
            "recording",
          ),
        ];
  const pages = chosen.map((rec): TranscriptPage => {
    const lines = transcriptLinesForCli(rec);
    const from = paged ? Math.min(start ?? 0, lines.length) : 0;
    return {
      id: rec.id,
      startedAt: rec.startedAt,
      participants: rec.participantCount ?? "auto",
      start: from,
      total: lines.length,
      lines: paged ? lines.slice(from, from + (limit ?? MAX_TRANSCRIPT_LINES)) : lines,
    };
  });
  const head = { id, title };
  if (paged) return { ...head, recordings: pages.map((page) => fittedPage(head, page)) };
  const result = { ...head, recordings: pages };
  if (!fitsAsResult(result)) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "the transcript is too large to send; read it a page at a time (start, limit) or on that computer",
    );
  }
  return result;
}

export const MAX_PHOTOS_PER_MINUTE = 30;

export class PhotoQuota {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly max = MAX_PHOTOS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  take(deviceId: string): void {
    const now = this.now();
    for (const [id, times] of this.recent) {
      const kept = times.filter((at) => now - at < 60_000);
      if (kept.length === 0) this.recent.delete(id);
      else this.recent.set(id, kept);
    }
    const times = this.recent.get(deviceId) ?? [];
    if (times.length >= this.max) {
      throw new RpcFailure(
        RpcErrorCode.Unavailable,
        `more than ${this.max} photos a minute: send the rest in a minute`,
      );
    }
    times.push(now);
    this.recent.set(deviceId, times);
  }
}

export async function attachToNote(
  notes: RemoteNotes,
  { workspaceId, noteId, mediaType, data, name }: RpcParams<"notes.attach">,
): Promise<RpcResult<"notes.attach">> {
  const bytes = Buffer.from(data, "base64");
  if (!bytes.byteLength || bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, "the photo is empty or too big");
  }
  if (!looksLike(bytes, mediaType)) {
    throw new RpcFailure(RpcErrorCode.InvalidParams, `the photo is not ${mediaType}`);
  }
  const { src } = await notes
    .attach(workspaceId, noteId, bytes, EXTENSIONS[mediaType], name?.trim() || undefined)
    .catch(failure);
  return { src };
}
