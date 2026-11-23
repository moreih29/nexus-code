import fs from "node:fs";
import path from "node:path";
import { toNativeDrivePath } from "../../../shared/fs/drive-path";
import { ipcContract } from "../../../shared/ipc/contract";
import { validateArgs } from "../../infra/ipc-router";

const openPathExternalArgsSchema = ipcContract.system.call.openPathExternal.args;
const revealInOSArgsSchema = ipcContract.system.call.revealInOS.args;

export type SystemPathErrorCode =
  | "not-absolute"
  | "not-found"
  | "permission-denied"
  | "open-failed";
export type SystemPathResult =
  | { ok: true }
  | {
      ok: false;
      error: { code: SystemPathErrorCode; message: string; absPath: string };
    };

export interface SystemShell {
  openPath(absPath: string): Promise<string>;
  showItemInFolder(absPath: string): void;
  trashItem(absPath: string): Promise<void>;
}

export function getElectronSystemShell(): SystemShell {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require("electron") as typeof import("electron");
  return shell;
}

function systemPathError(
  code: SystemPathErrorCode,
  absPath: string,
  message: string,
): SystemPathResult {
  return { ok: false, error: { code, message, absPath } };
}

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

export function openPathExternalHandler(
  shellImpl: SystemShell = getElectronSystemShell(),
): (args: unknown) => Promise<SystemPathResult> {
  return async (args: unknown): Promise<SystemPathResult> => {
    const absPath = toNativeDrivePath(validateArgs(openPathExternalArgsSchema, args).absPath);
    const validationError = await validateSystemPath(absPath);
    if (validationError) return validationError;

    const failureMessage = await shellImpl.openPath(absPath);
    if (failureMessage.length > 0) {
      return systemPathError("open-failed", absPath, failureMessage);
    }
    return { ok: true };
  };
}

export function revealInOSHandler(
  shellImpl: Pick<SystemShell, "showItemInFolder"> = getElectronSystemShell(),
): (args: unknown) => Promise<SystemPathResult> {
  return async (args: unknown): Promise<SystemPathResult> => {
    const absPath = toNativeDrivePath(validateArgs(revealInOSArgsSchema, args).absPath);
    const validationError = await validateSystemPath(absPath);
    if (validationError) return validationError;

    shellImpl.showItemInFolder(absPath);
    return { ok: true };
  };
}
