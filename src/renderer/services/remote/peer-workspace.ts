import { MAX_BYTES_CHUNK, MAX_READ_BYTES } from "../../../../packages/remote-protocol/src/rpc";
import { MAX_READABLE_FILE_SIZE, READ_RANGE_MAX_BYTES } from "../../../shared/fs/defaults";
import type { PeerWorkspace } from "../../../shared/fs/peer-url";
import { type IpcResult, ipcOk } from "../../../shared/ipc/result";
import { ipcCallResult } from "../../ipc/client";
import { bytesFromBase64 } from "../editor/encoding/text-encoding";

export { peerOf, peerWorkspaceId } from "../../../shared/fs/peer-url";

const roots = new Map<string, string>();

export function setPeerRoot(id: string, root: string): () => void {
  roots.set(id, root);
  return () => {
    if (roots.get(id) === root) roots.delete(id);
  };
}

export function peerRoot(id: string): string {
  return roots.get(id) ?? "";
}

export interface PeerPiece {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly version?: string;
}

async function readSpanResult(
  peer: PeerWorkspace,
  path: string,
  offset: number,
  length: number,
  requireVersion?: string,
  signal?: AbortSignal,
  whole?: true,
): Promise<IpcResult<PeerPiece>> {
  const read = await ipcCallResult(
    "remote",
    "peerFilesReadBytes",
    { ...peer, path, offset, length, requireVersion, whole },
    { signal },
  );
  if (!read.ok) return read;
  const { parts, size, version } = read.value;
  const decoded = parts.map(bytesFromBase64);
  const bytes = decoded.length === 1 ? decoded[0] : joinBytes(decoded);
  return ipcOk({ bytes, size, version });
}

async function readSpan(...args: Parameters<typeof readSpanResult>): Promise<PeerPiece | null> {
  const read = await readSpanResult(...args);
  return read.ok ? read.value : null;
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
    const piece = await readSpan(
      peer,
      path,
      at,
      Math.min(READ_RANGE_MAX_BYTES, end - at),
      first?.version ?? requireVersion,
      signal,
    );
    if (
      !piece ||
      (first && (piece.size !== first.size || (first.version && piece.version !== first.version)))
    )
      return null;
    first ??= piece;
    parts.push(piece.bytes);
    if (at + piece.bytes.length >= piece.size) break;
  }
  if (!first) return null;
  if (length === 0) return { ...first, bytes: first.bytes.subarray(0, 0) };
  return parts.length === 1 ? first : { ...first, bytes: joinBytes(parts) };
}

const PARALLEL = 4;

export type PeerBinary =
  | { readonly kind: "ok"; readonly bytes: Uint8Array; readonly version?: string }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed" };

export async function readPeerBinary(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<PeerBinary> {
  const head = await readSpan(peer, path, 0, MAX_BYTES_CHUNK, undefined, signal, true);
  if (!head) return { kind: "failed" };
  if (head.size > MAX_READABLE_FILE_SIZE) return { kind: "too_large" };
  return assemblePeerBinary(peer, path, head, signal);
}

async function assemblePeerBinary(
  peer: PeerWorkspace,
  path: string,
  head: PeerPiece,
  signal?: AbortSignal,
): Promise<PeerBinary> {
  if (head.bytes.length >= head.size)
    return { kind: "ok", bytes: head.bytes, ...(head.version ? { version: head.version } : {}) };
  const bytes = new Uint8Array(head.size);
  bytes.set(head.bytes);
  const offsets: number[] = [];
  for (let at = head.bytes.length; at < head.size; at += MAX_BYTES_CHUNK) offsets.push(at);
  for (let i = 0; i < offsets.length; i += PARALLEL) {
    const batch = await Promise.all(
      offsets
        .slice(i, i + PARALLEL)
        .map((at) =>
          readPeerPiece(
            peer,
            path,
            at,
            Math.min(MAX_BYTES_CHUNK, head.size - at),
            head.version,
            signal,
          ),
        ),
    );
    for (const [j, piece] of batch.entries()) {
      const at = offsets[i + j] ?? 0;
      if (
        !piece ||
        piece.size !== head.size ||
        piece.bytes.length !== Math.min(MAX_BYTES_CHUNK, head.size - at) ||
        (head.version && piece.version !== head.version)
      )
        return { kind: "failed" };
      bytes.set(piece.bytes.subarray(0, head.size - at), at);
    }
  }
  return { kind: "ok", bytes, ...(head.version ? { version: head.version } : {}) };
}

export async function probePeerVersion(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<string | undefined | null> {
  const piece = await readSpan(peer, path, 0, 1, undefined, signal);
  return piece ? piece.version : null;
}

const SNIFF_BYTES = 8000;

export const PEER_WORKSPACE_TEXT_LIMIT = 8 * 1024 * 1024;

export type PeerText =
  | { readonly kind: "text"; readonly text: string; readonly truncated?: boolean }
  | { readonly kind: "binary" }
  | { readonly kind: "too_large" }
  | { readonly kind: "failed"; readonly reason?: string };

interface PeerTextRead {
  text: PeerText;
  version?: string;
}

export async function readPeerText(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<PeerText> {
  return (await readPeerTextVersioned(peer, path, signal)).text;
}

export async function readPeerTextVersioned(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
): Promise<PeerTextRead> {
  const read = await readPeerBinary(peer, path, signal);
  return decodePeerText(read);
}

function decodePeerText(read: PeerBinary): PeerTextRead {
  if (read.kind !== "ok") return { text: read };
  if (read.bytes.subarray(0, SNIFF_BYTES).includes(0)) {
    return { text: { kind: "binary" }, version: read.version };
  }
  const text = new TextDecoder("utf-8").decode(read.bytes);
  return {
    text: { kind: "text", text: text.startsWith("\uFEFF") ? text.slice(1) : text },
    ...(read.version ? { version: read.version } : {}),
  };
}

export async function readPeerWorkspaceText(
  peer: PeerWorkspace,
  path: string,
  signal?: AbortSignal,
  { fullOnly = false }: { fullOnly?: boolean } = {},
): Promise<PeerTextRead> {
  const size = await readSpanResult(peer, path, 0, 1, undefined, signal);
  if (!size.ok) return { text: { kind: "failed", reason: size.kind } };
  if (size.value.size <= PEER_WORKSPACE_TEXT_LIMIT) {
    const head = await readSpanResult(
      peer,
      path,
      0,
      MAX_BYTES_CHUNK,
      size.value.version,
      signal,
      true,
    );
    if (!head.ok) return { text: { kind: "failed", reason: head.kind } };
    if (head.value.size <= PEER_WORKSPACE_TEXT_LIMIT) {
      return decodePeerText(await assemblePeerBinary(peer, path, head.value, signal));
    }
  }

  if (fullOnly) return { text: { kind: "too_large" } };
  const prefix = await ipcCallResult(
    "remote",
    "peerFilesRead",
    { ...peer, path, maxBytes: MAX_READ_BYTES },
    { signal },
  );
  if (!prefix.ok) return { text: { kind: "failed", reason: prefix.kind } };
  const value = prefix.value;
  if (value.kind === "binary") return { text: { kind: "binary" }, version: value.version };
  if (value.kind !== "text") return { text: { kind: "failed" } };
  return {
    text: { kind: "text", text: value.text, truncated: value.truncated },
    version: value.version,
  };
}

export { usePeerChatFileChanges, usePeerFileRevision, usePeerText } from "./peer-file-live";
