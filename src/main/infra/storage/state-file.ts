import fs from "node:fs";
import path from "node:path";
import type { AppState } from "../../../shared/types/app-state";
import { nestedErrorText } from "../../../shared/util/nested-error-text";
import { errnoText } from "./errno-text";

export const PREPARING = 0;
export const RENAMING = 1;
export const FINISHED = 2;
export const CANCELLED = 3;

const LOCKED_RENAME_RETRY_MS = [10, 20, 40, 80, 100];
const LOCKED_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

interface StateFileWrite {
  readonly canRename?: () => boolean;
  readonly rename?: (from: string, to: string) => void;
}

export function writeStateFile(
  filePath: string,
  tmpPath: string,
  state: AppState,
  { canRename, rename = (from, to) => fs.renameSync(from, to) }: StateFileWrite = {},
): boolean {
  const json = JSON.stringify(state, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, json, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!canRename || canRename()) {
      rename(tmpPath, filePath);
      return true;
    }
  } catch (error) {
    try {
      removeTemp(tmpPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${stateFailureText(error)}; temporary file cleanup: ${stateFailureText(cleanupError)}`,
      );
    }
    throw error;
  }
  removeTemp(tmpPath);
  return false;
}

export function renameWhenUnlocked(from: string, to: string, platform = process.platform): void {
  const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  for (const delay of platform === "win32" ? LOCKED_RENAME_RETRY_MS : []) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (!LOCKED_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    Atomics.wait(pause, 0, 0, delay);
  }
  fs.renameSync(from, to);
}

export function stateFailureText(error: unknown): string {
  return errnoText(error) ?? nestedErrorText(error);
}

function removeTemp(tmpPath: string): void {
  try {
    fs.unlinkSync(tmpPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
