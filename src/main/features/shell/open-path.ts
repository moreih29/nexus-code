/**
 * Workspace-agnostic shell path handlers.
 *
 * These calls intentionally accept absolute paths instead of workspace IDs so
 * git/file UI surfaces can reveal generated or external paths without routing
 * through workspace-relative fs safety helpers.
 */

import fs from "node:fs";
import path from "node:path";
import { ipcContract } from "../../../shared/ipc-contract";
import { validateArgs } from "../../infra/ipc/router";

const openPathExternalArgsSchema = ipcContract.system.call.openPathExternal.args;
const revealInOSArgsSchema = ipcContract.system.call.revealInOS.args;

type SystemPathErrorCode = "not-absolute" | "not-found" | "permission-denied" | "open-failed";
type SystemPathResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: SystemPathErrorCode; message: string; absPath: string };
    };

export interface SystemShell {
  openPath(absPath: string): Promise<string>;
  showItemInFolder(absPath: string): void;
}

/**
 * Lazily reads Electron's shell module so Bun unit tests can import this file
 * and inject a shell stub without evaluating Electron at module load time.
 */
export function getElectronSystemShell(): SystemShell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require("electron") as typeof import("electron");
  return shell;
}

/**
 * Converts a path validation failure into the typed IPC result consumed by the
 * renderer. Unknown access errors are reported as open-failed with details.
 */
function systemPathError(
  code: SystemPathErrorCode,
  absPath: string,
  message: string,
): SystemPathResult {
  return { ok: false, error: { code, message, absPath } };
}

/**
 * Ensures the provided path is absolute and still present before handing it to
 * Electron's shell APIs, which otherwise fail silently on missing files.
 */
async function validateSystemPath(absPath: string): Promise<SystemPathResult | null> {
  if (!path.isAbsolute(absPath)) {
    return systemPathError("not-absolute", absPath, "Expected an absolute path.");
  }

  try {
    await fs.promises.access(absPath, fs.constants.F_OK);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return systemPathError("not-found", absPath, "Path does not exist.");
    }
    if (code === "EACCES" || code === "EPERM") {
      return systemPathError("permission-denied", absPath, "Permission denied.");
    }
    return systemPathError(
      "open-failed",
      absPath,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Opens an existing absolute path with the operating system's default handler.
 * Electron returns a non-empty string when the OS open operation itself fails.
 */
export function openPathExternalHandler(
  shellImpl: SystemShell = getElectronSystemShell(),
): (args: unknown) => Promise<SystemPathResult> {
  return async (args: unknown): Promise<SystemPathResult> => {
    const { absPath } = validateArgs(openPathExternalArgsSchema, args);
    const validationError = await validateSystemPath(absPath);
    if (validationError) return validationError;

    const failureMessage = await shellImpl.openPath(absPath);
    if (failureMessage.length > 0) {
      return systemPathError("open-failed", absPath, failureMessage);
    }
    return { ok: true };
  };
}

/**
 * Reveals an existing absolute path in the platform file manager. The same
 * typed validation result is returned so renderer code can handle missing
 * files identically to openPathExternal.
 */
export function revealInOSHandler(
  shellImpl: Pick<SystemShell, "showItemInFolder"> = getElectronSystemShell(),
): (args: unknown) => Promise<SystemPathResult> {
  return async (args: unknown): Promise<SystemPathResult> => {
    const { absPath } = validateArgs(revealInOSArgsSchema, args);
    const validationError = await validateSystemPath(absPath);
    if (validationError) return validationError;

    shellImpl.showItemInFolder(absPath);
    return { ok: true };
  };
}
