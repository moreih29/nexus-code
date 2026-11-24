import { createHash } from "node:crypto";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_LISTED_NOTES,
  MAX_NOTE_MARKDOWN_PAGE,
  MAX_TRANSCRIPT_LINES,
  type NoteCounts,
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
      counts?: NoteCounts;
      excerpt?: string;
      recording?: { recordings: number; ms?: number; people?: number };
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
    notes: all
      .slice(0, MAX_LISTED_NOTES)
      .map(({ id, title, updatedAt, recording, counts, excerpt }) => ({
        id,
        title,
        updatedAt,
        recordings: recording?.recordings ?? 0,
        ...(recording?.ms === undefined ? {} : { recordingMs: recording.ms }),
        ...(recording?.people === undefined ? {} : { people: recording.people }),
        ...(counts ? { counts } : {}),
        ...(excerpt === undefined ? {} : { excerpt }),
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

type WireLine = ReturnType<typeof transcriptLinesForCli>[number];

function transcriptRevision(
  participants: NoteRecordingInfo["participants"],
  lines: readonly WireLine[],
): string {
  const hash = createHash("sha256").update(JSON.stringify(participants));
  for (const line of lines) hash.update(`\n${JSON.stringify(line)}`);
  return hash.digest("hex").slice(0, 16);
}

function recordingInfo(recording: TranscriptRecording): NoteRecordingInfo {
  const participants = recording.participantCount ?? "auto";
  return {
    id: recording.id,
    startedAt: recording.startedAt,
    ms: recordingMs(recording),
    lines: recording.lines.length,
    participants,
    revision: transcriptRevision(participants, transcriptLinesForCli(recording)),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function markdownCut(markdown: string, start: number, count: number): number {
  const end = Math.min(markdown.length, start + count);
  if (end < markdown.length && end > start && isHighSurrogate(markdown.charCodeAt(end - 1))) {
    return end - 1 > start ? end - 1 : end + 1;
  }
  return end;
}

export function markdownPageStart(markdown: string, start: number): number {
  const from = Math.min(start, markdown.length);
  return from > 0 &&
    from < markdown.length &&
    isLowSurrogate(markdown.charCodeAt(from)) &&
    isHighSurrogate(markdown.charCodeAt(from - 1))
    ? from - 1
    : from;
}

function fittedMarkdown<T extends { markdown: string }>(
  answer: T,
  whole: string,
  from: number,
  limit: number,
): T {
  const at = (count: number) => ({
    ...answer,
    markdown: whole.slice(from, markdownCut(whole, from, count)),
  });
  const room = Math.min(limit, whole.length - from);
  if (fitsAsResult(at(room))) return at(room);
  let low = 0;
  let high = room;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (fitsAsResult(at(mid))) low = mid;
    else high = mid;
  }
  const page = at(low);
  if (!page.markdown && room > 0) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "that part of the note is too large to send; read it on that computer",
    );
  }
  return page;
}

export async function readNote(
  services: CliServices,
  {
    workspaceId,
    note: selector,
    transcriptOnly,
    withoutTranscript,
    markdownStart,
    markdownLimit,
  }: RpcParams<"notes.read">,
): Promise<RpcResult<"notes.read">> {
  if (transcriptOnly && withoutTranscript) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "transcriptOnly and withoutTranscript cannot both be set",
    );
  }
  const paged = markdownStart !== undefined || markdownLimit !== undefined;
  if (paged && !withoutTranscript) {
    throw new RpcFailure(
      RpcErrorCode.InvalidParams,
      "markdownStart and markdownLimit read the body alone: set withoutTranscript",
    );
  }
  const note = await findNote(services, workspaceId, selector);
  const { id, title, updatedAt } = note;
  const file =
    transcriptOnly || note.recording
      ? await services.notes.transcript(workspaceId, id).catch(failure)
      : undefined;
  const transcript = file && !withoutTranscript ? transcriptMarkdown(file, title) : "";
  const markdown = transcriptOnly ? "" : noteMarkdown(note);
  const from = paged ? markdownPageStart(markdown, markdownStart ?? 0) : 0;
  const answer = {
    id,
    title,
    updatedAt,
    markdown,
    markdownStart: from,
    markdownTotal: markdown.length,
    transcript,
    recordings: file?.recordings.map(recordingInfo) ?? [],
  };
  if (paged) return fittedMarkdown(answer, markdown, from, markdownLimit ?? MAX_NOTE_MARKDOWN_PAGE);
  return boundedNoteResult(
    answer,
    transcript
      ? "the note is too large to send in one response; read it without its transcript (withoutTranscript) and its recordings with notes.transcript a page at a time"
      : "the note is too large to send in one response; read it a page at a time (withoutTranscript, markdownStart, markdownLimit)",
  );
}

type TranscriptPage = RpcResult<"notes.transcript">["recordings"][number];

function fittedPage(
  head: Omit<RpcResult<"notes.transcript">, "recordings">,
  page: TranscriptPage,
  revisionAfter: (count: number) => string,
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
  return { ...page, lines: page.lines.slice(0, low), revision: revisionAfter(low) };
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
  const pages = chosen.map((rec) => {
    const lines = transcriptLinesForCli(rec);
    const participants = rec.participantCount ?? "auto";
    const from = paged ? Math.min(start ?? 0, lines.length) : 0;
    const sent = paged ? lines.slice(from, from + (limit ?? MAX_TRANSCRIPT_LINES)) : lines;
    const revisionAfter = (count: number) =>
      transcriptRevision(participants, lines.slice(0, from + count));
    const page: TranscriptPage = {
      id: rec.id,
      startedAt: rec.startedAt,
      participants,
      start: from,
      total: lines.length,
      base: revisionAfter(0),
      revision: revisionAfter(sent.length),
      lines: sent,
    };
    return { page, revisionAfter };
  });
  const head = { id, title };
  if (paged) {
    return {
      ...head,
      recordings: pages.map(({ page, revisionAfter }) => fittedPage(head, page, revisionAfter)),
    };
  }
  const result = { ...head, recordings: pages.map(({ page }) => page) };
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
