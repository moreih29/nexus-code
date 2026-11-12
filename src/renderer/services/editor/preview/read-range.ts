// Reading a workspace file a part at a time, for the previews that need not
// take a large file whole (PDF). One fs.readRange call returns at most
// READ_RANGE_MAX_BYTES; a larger part is read in several, a few at once. It
// goes through the workspace, so local and SSH workspaces read the same.

import { READ_RANGE_MAX_BYTES } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";
import { bytesFromBase64 } from "../encoding/text-encoding";

/** A part of a file, and what the file was when it was read. */
export interface FilePart {
  readonly bytes: Uint8Array;
  /** The whole file's size. */
  readonly size: number;
  readonly mtime: string;
}

/** How many fs.readRange calls of one part are on their way at once. */
const PARALLEL_READS = 4;

/** Reads one piece of at most READ_RANGE_MAX_BYTES; null when it cannot. */
export type PieceReader = (offset: number, length: number) => Promise<FilePart | null>;

/** One fs.readRange call's piece; null when the file is missing or the read failed. */
async function readPiece(
  workspaceId: string,
  relPath: string,
  offset: number,
  length: number,
): Promise<FilePart | null> {
  const read = await ipcCallResult("fs", "readRange", { workspaceId, relPath, offset, length });
  if (!read.ok || read.value.kind !== "ok") return null;
  return {
    bytes: bytesFromBase64(read.value.base64),
    size: read.value.sizeBytes,
    mtime: read.value.mtime,
  };
}

/**
 * `length` bytes of `relPath` from `offset`, fewer at the end of the file.
 * Null when the file is missing, a read failed, or the file is no longer
 * as it was at `mtime` (or at the part's first piece).
 */
export function readWorkspaceRange(
  workspaceId: string,
  relPath: string,
  offset: number,
  length: number,
  mtime?: string,
): Promise<FilePart | null> {
  return readRange((at, size) => readPiece(workspaceId, relPath, at, size), offset, length, mtime);
}

/** readWorkspaceRange over `read`, a piece at a time. */
export async function readRange(
  read: PieceReader,
  offset: number,
  length: number,
  mtime?: string,
): Promise<FilePart | null> {
  const end = offset + length;
  const offsets = [offset];
  for (let at = offset + READ_RANGE_MAX_BYTES; at < end; at += READ_RANGE_MAX_BYTES) {
    offsets.push(at);
  }
  const pieces: FilePart[] = [];
  for (let i = 0; i < offsets.length; i += PARALLEL_READS) {
    const batch = await Promise.all(
      offsets
        .slice(i, i + PARALLEL_READS)
        .map((at) => read(at, Math.min(READ_RANGE_MAX_BYTES, end - at))),
    );
    for (const piece of batch) {
      if (piece === null || piece.mtime !== (mtime ?? pieces[0]?.mtime ?? piece.mtime)) {
        return null;
      }
      pieces.push(piece);
    }
  }
  const [first] = pieces;
  if (!first) return null;
  if (pieces.length === 1) return first;
  const bytes = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.bytes.length, 0));
  let at = 0;
  for (const piece of pieces) {
    bytes.set(piece.bytes, at);
    at += piece.bytes.length;
  }
  return { bytes, size: first.size, mtime: first.mtime };
}
