/**
 * What a background job (a Bash run in the background, a workflow) has
 * printed: the end of the file the CLI writes its output to, as a terminal
 * would leave it. Read through the workspace, so an SSH session's job is
 * read on its host; a file outside the workspace is read once the tab
 * grants it, which it does for its jobs' output files.
 */

import { ipcCallResult } from "../../ipc/client";
import { terminalText } from "../editor/preview/notebook";
import { bytesFromBase64 } from "../editor/preview/read-binary";
import { lookupPath } from "./file-presence";

/** How much of the file's end is read. */
export const TAIL_BYTES = 16 * 1024;
/** Most lines the end shows. */
export const TAIL_LINES = 40;

export interface JobOutput {
  /** The last lines, without escape codes. */
  lines: string[];
  /** Lines before these were left out. */
  cut: boolean;
  sizeBytes: number;
}

/**
 * The last `max` lines of `text`, read from the file's start or from
 * somewhere in it (`fromStart` false), whose first line is then cut by
 * where the read began and is dropped.
 */
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

/** Bytes of a file from `offset`, with its size; null when it cannot be read. */
export type RangeRead = (
  workspaceId: string,
  relPath: string,
  offset: number,
  length: number,
) => Promise<{ base64: string; sizeBytes: number } | null>;

const readRange: RangeRead = async (workspaceId, relPath, offset, length) => {
  const read = await ipcCallResult("fs", "readRange", {
    workspaceId,
    relPath,
    offset,
    length,
  }).catch(() => null);
  return read?.ok && read.value.kind === "ok" ? read.value : null;
};

/**
 * The path the workspace at `root` reads `path` by: relative under it, or
 * itself outside it; null for a path it cannot read.
 */
export function outputReadPath(path: string, root: string): string | null {
  const rel = lookupPath(path, root);
  if (rel !== null) return rel;
  return path.startsWith("/") ? path : null;
}

/** The end of the output file at `path`; null while it cannot be read. */
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
