/**
 * Absolute-path read helpers shared by main-process callers.
 */
import fs from "node:fs";
import {
  BINARY_DETECTION_BYTES,
  isHiddenName,
  MAX_READABLE_FILE_SIZE,
} from "../../../shared/fs-defaults";
import { FS_ERROR, fsCodeFromErrno, fsErrorMessage } from "../../../shared/fs-errors";
import type { DirEntry, FileReadResult, FsStat } from "../../../shared/types/fs";
import { isBinaryProbe } from "../../filesystem/binary-detect";

/**
 * Read a directory from an already-authorized absolute path.
 */
export async function readdirCore(absDir: string): Promise<DirEntry[]> {
  const dirents = await fs.promises.readdir(absDir, { withFileTypes: true });
  return dirents
    .filter((d) => !isHiddenName(d.name))
    .map((d) => ({
      name: d.name,
      type: d.isDirectory() ? "dir" : d.isSymbolicLink() ? "symlink" : "file",
    }));
}

/**
 * Return lstat metadata for an already-authorized absolute path.
 */
export async function statCore(abs: string): Promise<FsStat> {
  const stat = await fs.promises.lstat(abs);
  const type = stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "symlink" : "file";
  return {
    type,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    isSymlink: stat.isSymbolicLink(),
  };
}

/**
 * Detect whether a buffer is binary and build the appropriate FileReadResult "ok" variant.
 */
export function buildFileContent(buf: Buffer, stat: fs.Stats): FileReadResult & { kind: "ok" } {
  const probe = buf.slice(0, BINARY_DETECTION_BYTES);
  const mtime = stat.mtime.toISOString();

  if (isBinaryProbe(probe)) {
    return {
      kind: "ok",
      content: "",
      encoding: "utf8",
      sizeBytes: stat.size,
      isBinary: true,
      mtime,
    };
  }

  // UTF-8 BOM detection
  if (probe.length >= 3 && probe[0] === 0xef && probe[1] === 0xbb && probe[2] === 0xbf) {
    return {
      kind: "ok",
      content: buf.slice(3).toString("utf8"),
      encoding: "utf8-bom",
      sizeBytes: stat.size,
      isBinary: false,
      mtime,
    };
  }

  return {
    kind: "ok",
    content: buf.toString("utf8"),
    encoding: "utf8",
    sizeBytes: stat.size,
    isBinary: false,
    mtime,
  };
}

/**
 * Read file content from an already-authorized absolute path.
 */
export async function readFileCore(abs: string): Promise<FileReadResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(abs);
  } catch (e: unknown) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { kind: "missing", reason: "not-found" };
    const code = fsCodeFromErrno(errno);
    if (code) throw new Error(fsErrorMessage(code, abs));
    throw e;
  }

  if (stat.isDirectory()) {
    throw new Error(fsErrorMessage(FS_ERROR.IS_DIRECTORY, abs));
  }

  if (stat.size > MAX_READABLE_FILE_SIZE) {
    throw new Error(fsErrorMessage(FS_ERROR.TOO_LARGE, `${abs} (${stat.size} bytes)`));
  }

  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(abs);
  } catch (e: unknown) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") return { kind: "missing", reason: "not-found" };
    const code = fsCodeFromErrno(errno);
    if (code) throw new Error(fsErrorMessage(code, abs));
    throw e;
  }

  return buildFileContent(buf, stat);
}
