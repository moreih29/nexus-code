import { isAbsoluteOutsidePath } from "../../../shared/fs/outside-url";
import { peerOf } from "../../../shared/fs/peer-url";
import { ipcCallResult } from "../../ipc/client";
import { bytesFromBase64, bytesToBase64 } from "../editor/encoding/text-encoding";
import { terminalText } from "../editor/preview/notebook";
import { readPeerPiece } from "../remote/peer-workspace";
import { lookupPath } from "./file-presence";

export const TAIL_BYTES = 16 * 1024;
export const TAIL_LINES = 40;

export interface JobOutput {
  lines: string[];
  cut: boolean;
  sizeBytes: number;
}

export function tailOf(
  text: string,
  fromStart: boolean,
  max = TAIL_LINES,
): Pick<JobOutput, "lines" | "cut"> {
  let lines = terminalText(text).split("\n");
  if (lines.at(-1) === "") lines.pop();
  let cut = false;
  if (!fromStart) {
    lines = lines.slice(1);
    cut = true;
  }
  if (lines.length > max) {
    lines = lines.slice(-max);
    cut = true;
  }
  return { lines, cut };
}

export type RangeRead = (
  workspaceId: string,
  relPath: string,
  offset: number,
  length: number,
) => Promise<{ base64: string; sizeBytes: number } | null>;

const readRange: RangeRead = async (workspaceId, relPath, offset, length) => {
  const peer = peerOf(workspaceId);
  if (peer) {
    const piece = await readPeerPiece(peer, relPath, offset, length).catch(() => null);
    return piece ? { base64: bytesToBase64(piece.bytes), sizeBytes: piece.size } : null;
  }
  const read = await ipcCallResult("fs", "readRange", {
    workspaceId,
    relPath,
    offset,
    length,
  }).catch(() => null);
  return read?.ok && read.value.kind === "ok" ? read.value : null;
};

export function outputReadPath(path: string, root: string): string | null {
  const rel = lookupPath(path, root);
  if (rel !== null) return rel;
  return isAbsoluteOutsidePath(path) ? path : null;
}

export async function readJobOutput(
  workspaceId: string,
  root: string,
  path: string,
  read: RangeRead = readRange,
): Promise<JobOutput | null> {
  const relPath = outputReadPath(path, root);
  if (relPath === null) return null;
  const head = await read(workspaceId, relPath, 0, 0);
  if (!head) return null;
  if (head.sizeBytes === 0) return { lines: [], cut: false, sizeBytes: 0 };
  const offset = Math.max(0, head.sizeBytes - TAIL_BYTES);
  const body = await read(workspaceId, relPath, offset, head.sizeBytes - offset);
  if (!body) return null;
  const text = new TextDecoder().decode(bytesFromBase64(body.base64));
  return { ...tailOf(text, offset === 0), sizeBytes: head.sizeBytes };
}
