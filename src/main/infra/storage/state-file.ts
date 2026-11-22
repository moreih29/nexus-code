import fs from "node:fs";
import path from "node:path";
import type { AppState } from "../../../shared/types/app-state";

// flushNow cancels a preparing worker or waits for its rename to finish before
// publishing the latest snapshot.
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
      // The destination is replaced only after the complete file is synced.
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
        `${error}; temporary file cleanup: ${cleanupError}`,
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
