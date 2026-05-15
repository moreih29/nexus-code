/**
 * Shared error → toast translator for fs-mutations services.
 *
 * The main-process handlers throw `Error("CODE: <abs path>")` strings
 * encoded by their try/catch blocks. This helper inspects the message
 * for known prefixes and emits a user-facing toast. Lives next to the
 * services so each operation can `catch (e) → toFsToast(e, "Couldn't
 * create file.")` without re-implementing the dispatch.
 */

import { showToast } from "@/components/ui/toast";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs/fs-errors";

export interface FsToastMessages {
  /** Generic fallback when no code matches. */
  fallback: string;
  /** Override for ALREADY_EXISTS, e.g. "A file with that name already exists." */
  alreadyExists?: string;
  /** Override for NOT_FOUND. */
  notFound?: string;
  /** Override for PERMISSION_DENIED. */
  permissionDenied?: string;
  /** Override for NOT_EMPTY. */
  notEmpty?: string;
  /** Override for NOT_DIRECTORY. */
  notDirectory?: string;
  /** Override for CROSS_DEVICE. */
  crossDevice?: string;
}

export function toFsToast(error: unknown, msgs: FsToastMessages): void {
  if (hasFsErrorCode(error, FS_ERROR.ALREADY_EXISTS)) {
    showToast({ kind: "error", message: msgs.alreadyExists ?? "Already exists." });
    return;
  }
  if (hasFsErrorCode(error, FS_ERROR.NOT_FOUND)) {
    showToast({ kind: "error", message: msgs.notFound ?? "Path not found." });
    return;
  }
  if (hasFsErrorCode(error, FS_ERROR.PERMISSION_DENIED)) {
    showToast({ kind: "error", message: msgs.permissionDenied ?? "Permission denied." });
    return;
  }
  if (hasFsErrorCode(error, FS_ERROR.NOT_EMPTY)) {
    showToast({ kind: "error", message: msgs.notEmpty ?? "Folder is not empty." });
    return;
  }
  if (hasFsErrorCode(error, FS_ERROR.NOT_DIRECTORY)) {
    showToast({ kind: "error", message: msgs.notDirectory ?? "Path is not a folder." });
    return;
  }
  if (hasFsErrorCode(error, FS_ERROR.CROSS_DEVICE)) {
    showToast({ kind: "error", message: msgs.crossDevice ?? "Can't move across filesystems." });
    return;
  }
  showToast({ kind: "error", message: msgs.fallback });
}
