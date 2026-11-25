import fs from "node:fs";
import path from "node:path";
import type { AppState } from "../../../shared/types/app-state";
import { nestedErrorText } from "../../../shared/util/nested-error-text";

export const PREPARING = 0;
export const RENAMING = 1;
export const FINISHED = 2;
export const CANCELLED = 3;

export function writeStateFile(
  filePath: string,
  tmpPath: string,
  state: AppState,
  canRename?: () => boolean,
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
      fs.renameSync(tmpPath, filePath);
      return true;
    }
  } catch (error) {
    try {
      removeTemp(tmpPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${nestedErrorText(error)}; temporary file cleanup: ${nestedErrorText(cleanupError)}`,
      );
    }
    throw error;
  }
  removeTemp(tmpPath);
  return false;
}

function removeTemp(tmpPath: string): void {
  try {
    fs.unlinkSync(tmpPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
