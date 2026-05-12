import path from "node:path";
import { readdirCore, readFileCore, statCore } from "../main/fs/core/read-core";
import { FS_ERROR, fsErrorMessage } from "../shared/fs-errors";
import type { DirEntry, FileReadResult, FsStat } from "../shared/types/fs";

export interface ServerFsParams {
  readonly relPath: string;
}

/**
 * Reads a workspace-relative directory through the shared fs core helpers.
 */
export async function handleReaddir(rootPath: string, params: unknown): Promise<DirEntry[]> {
  return readdirCore(resolveServerPath(rootPath, readRelPathParam(params)));
}

/**
 * Reads workspace-relative metadata through the shared fs core helpers.
 */
export async function handleStat(rootPath: string, params: unknown): Promise<FsStat> {
  return statCore(resolveServerPath(rootPath, readRelPathParam(params)));
}

/**
 * Reads workspace-relative file content through the shared fs core helpers.
 */
export async function handleReadFile(rootPath: string, params: unknown): Promise<FileReadResult> {
  return readFileCore(resolveServerPath(rootPath, readRelPathParam(params)));
}

/**
 * Resolves a remote request path relative to the server root and rejects escapes.
 */
function resolveServerPath(rootPath: string, relPath: string): string {
  const abs = path.resolve(rootPath, relPath || ".");
  const rel = path.relative(rootPath, abs);

  if (rel === "" || rel === ".") {
    return abs;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(fsErrorMessage(FS_ERROR.OUT_OF_WORKSPACE, relPath));
  }

  return abs;
}

/**
 * Extracts the relPath argument used by all read-only server fs methods.
 */
function readRelPathParam(params: unknown): string {
  if (!isRecord(params) || typeof params.relPath !== "string") {
    throw new ServerProtocolError("fs method params must include relPath");
  }

  return params.relPath;
}

/**
 * Narrows unknown JSON params to object records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Error type used when fs params violate the server request protocol.
 */
export class ServerProtocolError extends Error {
  readonly code = "server.protocol-error";
}
