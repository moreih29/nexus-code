/**
 * A workspace's notes for the account's other devices: which there are
 * (notes.list), and a photo put at the end of one (notes.attach), as a
 * phone gives the note a meeting is recorded into a picture of the
 * whiteboard. The note it records into is in the sessions' list.
 */
import {
  MAX_ATTACHMENT_BYTES,
  MAX_LISTED_NOTES,
  type RemoteRecording,
  RpcErrorCode,
  type RpcParams,
  type RpcResult,
} from "../../../../packages/remote-protocol/src";
import { RpcFailure } from "./room";

/** The image files a note keeps a photo as, by the type it came as. */
const EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;

export type NotePhotoExtension = (typeof EXTENSIONS)[keyof typeof EXTENSIONS];

/** The app's notes, as the remote serves them. */
export interface RemoteNotes {
  /** The workspace's notes, the last changed first. */
  list(workspaceId: string): Promise<readonly { id: string; title: string; updatedAt: number }[]>;
  /** Puts a photo at the end of the note: where the note keeps it. */
  attach(
    workspaceId: string,
    noteId: string,
    bytes: Uint8Array,
    ext: NotePhotoExtension,
    name?: string,
  ): Promise<{ src: string }>;
  /** The note it records into, while it records. */
  recording(): RemoteRecording | undefined;
}

/** A note's failure as the remote tells it: no such note, a bad request, or not now. */
function failure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "not-found" || /^no workspace /.test(message)) {
    throw new RpcFailure(RpcErrorCode.NotFound, message);
  }
  if (code === "bad-request") throw new RpcFailure(RpcErrorCode.InvalidParams, message);
  throw new RpcFailure(RpcErrorCode.Unavailable, message);
}

/** Whether the bytes start as an image of the type says. */
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

/** Most photos one device may put into notes here a minute; more are Unavailable. */
export const MAX_PHOTOS_PER_MINUTE = 30;

/**
 * How many photos each device put into notes within the last minute: a
 * photo is small, but a device sending them without end would fill the
 * disk a note at a time.
 */
export class PhotoQuota {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly max = MAX_PHOTOS_PER_MINUTE,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a photo of `deviceId`'s; Unavailable past the minute's share. */
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
