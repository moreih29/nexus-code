/**
 * Another computer's workspace, as this one's previews read it (quick look
 * over its chat): its files' bytes through the room (files.read), a piece
 * at a time, and the folder it is at there, which its chat's pane tells.
 */

import { useEffect, useState } from "react";
import { MAX_BYTES_CHUNK } from "../../../../packages/remote-protocol/src/rpc";
import { MAX_READABLE_FILE_SIZE, READ_RANGE_MAX_BYTES } from "../../../shared/fs/defaults";
import { type PeerWorkspace, peerOf } from "../../../shared/fs/peer-url";
import { ipcCallResult } from "../../ipc/client";
import { bytesFromBase64 } from "../editor/encoding/text-encoding";

export { peerOf, peerWorkspaceId } from "../../../shared/fs/peer-url";

/** The folders the workspaces of other computers are at there, by their peer workspace ids. */
const roots = new Map<string, string>();

/** Tells where another computer's workspace is there, while a pane of its shows. */
export function setPeerRoot(id: string, root: string): () => void {
  roots.set(id, root);
  return () => {
    if (roots.get(id) === root) roots.delete(id);
  };
}

/** The folder another computer's workspace is at there; "" when no pane told it. */
export function peerRoot(id: string): string {
  return roots.get(id) ?? "";
}

/** A piece of a file of another computer's, and the file's generation when available. */
export interface PeerPiece {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly version?: string;
}

async function readSpan(
  peer: PeerWorkspace,
  path: string,
  offset: number,
  length: number,
  requireVersion?: string,
  signal?: AbortSignal,
  whole?: true,
): Promise<PeerPiece | null> {
  const read = await ipcCallResult(
    "remote",
    "peerFilesReadBytes",
    { ...peer, path, offset, length, requireVersion, whole },
    { signal },
  );
  if (!read.ok) return null;
  const { parts, size, version } = read.value;
  const decoded = parts.map(bytesFromBase64);
  const bytes = decoded.length === 1 ? decoded[0] : joinBytes(decoded);
  return bytes ? { bytes, size, version } : null;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** Reads just the requested span, with a fresh host check for an independently requested span. */
export async function readPeerPiece(
  peer: PeerWorkspace,
  path: string,
  offset: number,
  length: number,
  requireVersion?: string,
  signal?: AbortSignal,
): Promise<PeerPiece | null> {
  const parts: Uint8Array[] = [];
  let first: PeerPiece | null = null;
  const end = offset + Math.max(1, length);
  for (let at = offset; at < end; at += READ_RANGE_MAX_BYTES) {
    const piece = await readSpan(peer, path, at, Math.min(READ_RANGE_MAX_BYTES, end - at), first?.version ?? requireVersion, signal);
    if (!piece || (first && (piece.size !== first.size || (first.version && piece.version !== first.version)))) return null;
    first ??= piece;
    parts.push(piece.bytes);
    if (at + piece.bytes.length >= piece.size) break;
  }
  if (!first) return null;
  if (length === 0) return { ...first, bytes: first.bytes.subarray(0, 0) };
  return parts.length === 1 ? first : { ...first, bytes: joinBytes(parts) };
}

/** How many pieces of a whole file are on their way at once. */
const PARALLEL = 4;

export type PeerBinary =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

/** All of a file of another computer's, within the readable file size limit. */
export async function readPeerBinary(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<PeerBinary> {
  const head = await readSpan(peer, path, 0, MAX_BYTES_CHUNK, undefined, signal, true);
  if (!head) return { kind: "failed" };
  if (head.size > MAX_READABLE_FILE_SIZE) return { kind: "too_large" };
  if (head.bytes.length >= head.size) return { kind: "ok", bytes: head.bytes };
  const bytes = new Uint8Array(head.size);
  bytes.set(head.bytes);
  const offsets: number[] = [];
  for (let at = head.bytes.length; at < head.size; at += MAX_BYTES_CHUNK) offsets.push(at);
  for (let i = 0; i < offsets.length; i += PARALLEL) {
    const batch = await Promise.all(
      offsets
        .slice(i, i + PARALLEL)
        .map((at) => readPeerPiece(peer, path, at, Math.min(MAX_BYTES_CHUNK, head.size - at), head.version, signal)),
    );
    for (const [j, piece] of batch.entries()) {
      const at = offsets[i + j] ?? 0;
      // A file that changed size while it was read is not shown as either.
      if (!piece || piece.size !== head.size || (head.version && piece.version !== head.version)) return { kind: "failed" };
      bytes.set(piece.bytes.subarray(0, head.size - at), at);
    }
  }
  return { kind: "ok", bytes };
}

/** How far into a file a NUL makes it binary, as the editor tells. */
const SNIFF_BYTES = 8000;

export type PeerText =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "binary" }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

/** A text file of another computer's, as UTF-8, its byte-order mark left out. */
export async function readPeerText(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<PeerText> {
  const read = await readPeerBinary(peer, path, signal);
  if (read.kind !== "ok") return read;
  if (read.bytes.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary" };
  const text = new TextDecoder("utf-8").decode(read.bytes);
  return { kind: "text", text: text.startsWith("\uFEFF") ? text.slice(1) : text };
}

/** The text another computer's file holds, read through the room; null while it comes. */
export function usePeerText(workspaceId: string, path: string): PeerText | null {
  const [read, setRead] = useState<{ workspaceId: string; path: string; text: PeerText } | null>(null);
  useEffect(() => {
    const peer = peerOf(workspaceId);
    if (!peer) return;
    const abort = new AbortController();
    void readPeerText(peer, path, abort.signal).then(
      (text) => !abort.signal.aborted && setRead({ workspaceId, path, text }),
      () => !abort.signal.aborted && setRead({ workspaceId, path, text: { kind: "failed" } }),
    );
    return () => abort.abort();
  }, [workspaceId, path]);
  return read?.workspaceId === workspaceId && read.path === path ? read.text : null;
}
