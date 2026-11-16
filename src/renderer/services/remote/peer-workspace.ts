/**
 * Another computer's workspace, as this one's previews read it (quick look
 * over its chat): its files' bytes through the room (files.read), a piece
 * at a time, and the folder it is at there, which its chat's pane tells.
 */

import { useEffect, useState } from "react";
import { MAX_BYTES_CHUNK } from "../../../../packages/remote-protocol/src/rpc";
import { MAX_READABLE_FILE_SIZE } from "../../../shared/fs/defaults";
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

/** A piece of a file of another computer's, and the file's size. */
export interface PeerPiece {
  readonly bytes: Uint8Array;
  readonly size: number;
}

/**
 * Up to `length` bytes of `path` from `offset`, in requests of at most
 * MAX_BYTES_CHUNK; fewer at the end of the file. Null when it cannot be read.
 */
export async function readPeerPiece(
  peer: PeerWorkspace,
  path: string,
  offset: number,
  length: number,
): Promise<PeerPiece | null> {
  const offsets: number[] = [];
  for (let at = offset; at < offset + Math.max(1, length); at += MAX_BYTES_CHUNK) offsets.push(at);
  const reads = await Promise.all(
    offsets.map((at) =>
      ipcCallResult("remote", "peerFilesRead", {
        deviceId: peer.deviceId,
        workspaceId: peer.workspaceId,
        path,
        as: "bytes",
        offset: at,
        length: Math.max(1, Math.min(MAX_BYTES_CHUNK, offset + length - at)),
      }),
    ),
  );
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const read of reads) {
    if (!read.ok || read.value.kind !== "bytes") return null;
    size = read.value.size;
    parts.push(bytesFromBase64(read.value.data));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(Math.min(total, Math.max(0, length)));
  let at = 0;
  for (const part of parts) {
    const take = part.subarray(0, bytes.length - at);
    bytes.set(take, at);
    at += take.length;
  }
  return { bytes, size };
}

/** How many pieces of a whole file are on their way at once. */
const PARALLEL = 4;

export type PeerBinary =
  | { readonly kind: "ok"; readonly bytes: Uint8Array }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

/** All of a file of another computer's, within the readable file size limit. */
export async function readPeerBinary(peer: PeerWorkspace, path: string): Promise<PeerBinary> {
  const head = await readPeerPiece(peer, path, 0, MAX_BYTES_CHUNK);
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
        .map((at) => readPeerPiece(peer, path, at, Math.min(MAX_BYTES_CHUNK, head.size - at))),
    );
    for (const [j, piece] of batch.entries()) {
      const at = offsets[i + j] ?? 0;
      // A file that changed size while it was read is not shown as either.
      if (!piece || piece.size !== head.size) return { kind: "failed" };
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
export async function readPeerText(peer: PeerWorkspace, path: string): Promise<PeerText> {
  const read = await readPeerBinary(peer, path);
  if (read.kind !== "ok") return read;
  if (read.bytes.subarray(0, SNIFF_BYTES).includes(0)) return { kind: "binary" };
  const text = new TextDecoder("utf-8").decode(read.bytes);
  return { kind: "text", text: text.startsWith("\uFEFF") ? text.slice(1) : text };
}

/** The text another computer's file holds, read through the room; null while it comes. */
export function usePeerText(workspaceId: string, path: string): PeerText | null {
  const [read, setRead] = useState<{ path: string; text: PeerText } | null>(null);
  useEffect(() => {
    const peer = peerOf(workspaceId);
    if (!peer) return;
    let live = true;
    void readPeerText(peer, path).then(
      (text) => live && setRead({ path, text }),
      () => live && setRead({ path, text: { kind: "failed" } }),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, path]);
  return read?.path === path ? read.text : null;
}
