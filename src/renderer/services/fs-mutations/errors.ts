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

export interface FsToastMessages {
  /** Generic fallback when no code matches. */
  fallback: string;
  /** Override for ALREADY_EXISTS, e.g. "A file with that name already exists." */
  alreadyExists?: string;
  /** Override for NOT_FOUND. */
  notFound?: string;
  /** Override for PERMISSION_DENIED. */
  permissionDenied?: string;
}

export function toFsToast(error: unknown, msgs: FsToastMessages): void {
  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes("ALREADY_EXISTS")) {
    showToast({ kind: "error", message: msgs.alreadyExists ?? "Already exists." });
    return;
  }
  if (raw.includes("NOT_FOUND")) {
    showToast({ kind: "error", message: msgs.notFound ?? "Path not found." });
    return;
  }
  if (raw.includes("PERMISSION_DENIED")) {
    showToast({ kind: "error", message: msgs.permissionDenied ?? "Permission denied." });
    return;
  }
  showToast({ kind: "error", message: msgs.fallback });
}
