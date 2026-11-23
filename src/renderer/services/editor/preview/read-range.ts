import { READ_RANGE_MAX_BYTES } from "../../../../shared/fs/defaults";
import { ipcCallResult } from "../../../ipc/client";
import { peerOf, readPeerPiece } from "../../remote/peer-workspace";
import { bytesFromBase64 } from "../encoding/text-encoding";

export interface FilePart {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly mtime: string;
}

const PARALLEL_READS = 4;

export type PieceReader = (offset: number, length: number) => Promise<FilePart | null>;

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

export function readWorkspaceRange(
  workspaceId: string,
  relPath: string,
  offset: number,
  length: number,
  mtime?: string,
  signal?: AbortSignal,
): Promise<FilePart | null> {
  const peer = peerOf(workspaceId);
  if (peer) {
    const required = mtime?.startsWith("version:") ? mtime.slice("version:".length) : undefined;
    return readPeerPiece(peer, relPath, offset, length, required, signal).then((piece) => {
      if (!piece || signal?.aborted) return null;
      const revision =
        piece.version && !mtime?.startsWith("size:")
          ? `version:${piece.version}`
          : `size:${piece.size}`;
      return mtime !== undefined && revision !== mtime ? null : { ...piece, mtime: revision };
    });
  }
  return readRange((at, size) => readPiece(workspaceId, relPath, at, size), offset, length, mtime);
}

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
