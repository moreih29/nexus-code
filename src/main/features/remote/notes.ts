import {
  MAX_ATTACHMENT_BYTES,
  MAX_LISTED_NOTES,
  type RemoteRecording,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { transcriptLinesForCli, transcriptMarkdown } from "../../../shared/notes/transcript";
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
  list(workspaceId: string): Promise<readonly { id: string; title: string; updatedAt: number }[]>;
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
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
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

export function boundedNoteResult<T>(result: T): T {
  if (!fitsAsResult(result)) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "the note is too large to send in one response; read it on that computer",
    );
  }
  return result;
}

export async function readNote(
  services: CliServices,
  { workspaceId, note: selector, transcriptOnly }: RpcParams<"notes.read">,
): Promise<RpcResult<"notes.read">> {
  const note = await findNote(services, workspaceId, selector);
  const { id, title, updatedAt } = note;
  const transcript =
    transcriptOnly || note.recording
      ? transcriptMarkdown(await services.notes.transcript(workspaceId, id).catch(failure), title)
      : "";
  return boundedNoteResult({
    id,
    title,
    updatedAt,
    markdown: transcriptOnly ? "" : noteMarkdown(note),
    transcript,
  });
}

export async function noteTranscript(
  services: CliServices,
  { workspaceId, note: selector, recording }: RpcParams<"notes.transcript">,
): Promise<RpcResult<"notes.transcript">> {
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
  const result = {
    id,
    title,
    recordings: chosen.map((rec) => ({
      id: rec.id,
      startedAt: rec.startedAt,
      participants: rec.participantCount ?? "auto",
      lines: transcriptLinesForCli(rec),
    })),
  };
  if (!fitsAsResult(result)) {
    throw new RpcFailure(
      RpcErrorCode.Unavailable,
      "the transcript is too large to send; select a recording or read it on that computer",
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
