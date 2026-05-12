/**
 * Absolute-path reader for files outside a workspace provider.
 */
import path from "node:path";
import { FS_ERROR } from "../../shared/fs-errors";
import type { FileReadResult } from "../../shared/types/fs";
import { readFileCore } from "./core/read-core";

/**
 * Reads an absolute path that is intentionally outside workspace path safety.
 */
export async function readExternal(absolutePath: string): Promise<FileReadResult> {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`${FS_ERROR.NOT_FOUND}: path must be absolute: ${absolutePath}`);
  }

  return readFileCore(absolutePath);
}
