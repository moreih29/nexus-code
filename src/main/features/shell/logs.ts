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
