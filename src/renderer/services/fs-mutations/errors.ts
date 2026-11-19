/**
 * Shared error → toast translator for fs-mutations services.
 *
 * The main-process handlers throw `Error("CODE: <abs path>")` strings
 * encoded by their try/catch blocks. This helper inspects the message
 * for known prefixes and emits a user-facing toast. Lives next to the
 * services so each operation can `catch (e) → toFsToast(e, "Couldn't
 * create file.")` without re-implementing the dispatch.
 */

import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { FS_ERROR } from "../../../shared/fs/errors";
import { isAppError } from "../../hooks/use-ipc-action";
import { classifyFsError } from "../../utils/error-classification";
import { surfaceError } from "../error-surface/surface-error";

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
  /** Override for UNSUPPORTED_REMOTE (e.g. SSH workspace). */
  unsupportedRemote?: string;
}

// Keep this order when multiple codes appear in an IPC wrapper.
const MESSAGE_OVERRIDES = {
  [FS_ERROR.ALREADY_EXISTS]: "alreadyExists",
  [FS_ERROR.NOT_FOUND]: "notFound",
  [FS_ERROR.PERMISSION_DENIED]: "permissionDenied",
  [FS_ERROR.NOT_EMPTY]: "notEmpty",
  [FS_ERROR.NOT_DIRECTORY]: "notDirectory",
  [FS_ERROR.CROSS_DEVICE]: "crossDevice",
  [FS_ERROR.UNSUPPORTED_REMOTE]: "unsupportedRemote",
} as const;
const MUTATION_CODES = Object.keys(MESSAGE_OVERRIDES) as (keyof typeof MESSAGE_OVERRIDES)[];

/** Shows the mutation-specific copy and severity for the classified failure. */
export function toFsToast(error: unknown, msgs: FsToastMessages): void {
  // Structured transport and bug outcomes use the common policy; keep the
  // existing file-operation copy and warning severity for domain FsErrorCode.
  if (isAppError(error) && (error.category !== "failed" || error.domain !== "fs")) {
    surfaceError(error, { surface: "auto" });
    return;
  }

  const code = classifyFsError(error, MUTATION_CODES);
  const key = code === undefined ? undefined : MESSAGE_OVERRIDES[code];
  showToast({
    // NOT_EMPTY asks the user to decide before a destructive operation.
    kind: code === FS_ERROR.NOT_EMPTY ? "warning" : "error",
    message:
      key === undefined ? msgs.fallback : (msgs[key] ?? i18next.t(`files:fileTree.fsError.${key}`)),
  });
}
