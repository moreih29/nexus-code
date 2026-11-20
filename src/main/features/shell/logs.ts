/**
 * system.logsPath and system.openLogsFolder: where the app's log files are, for
 * a user who has to send them. The folder is the one the log writer uses
 * (`app.getPath("logs")`), asked of the app here and not of the renderer's
 * view of the log library.
 */

import fs from "node:fs";
import type { SystemPathResult, SystemShell } from "./open-path";
import { getElectronSystemShell } from "./open-path";

function electronLogsDir(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require("electron") as typeof import("electron");
  return app.getPath("logs");
}

export function logsPathHandler(
  getDir: () => string = electronLogsDir,
): () => Promise<{ path: string }> {
  return async () => ({ path: getDir() });
}

/**
 * Opens the log folder. The folder is made first: the log writer makes it with
 * the first line, and a user can look before any line is written.
 */
export function openLogsFolderHandler(
  getDir: () => string = electronLogsDir,
  shellImpl: Pick<SystemShell, "openPath"> | null = null,
): () => Promise<SystemPathResult> {
  return async () => {
    const absPath = getDir();
    try {
      await fs.promises.mkdir(absPath, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "open-failed",
          message: error instanceof Error ? error.message : String(error),
          absPath,
        },
      };
    }
    const failure = await (shellImpl ?? getElectronSystemShell()).openPath(absPath);
    if (failure.length > 0) {
      return { ok: false, error: { code: "open-failed", message: failure, absPath } };
    }
    return { ok: true };
  };
}
