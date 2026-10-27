/**
 * Summary toast text for multi-item file operations (delete, paste, drop)
 * that failed on some of their items.
 */

import i18next from "i18next";
import { fsErrorReason } from "@/utils/file-error";
import { basename } from "@/utils/path";

/** The first item a multi-item operation failed on. */
export interface BatchFailure {
  /** Base name of the item. */
  name: string;
  /** Why it failed, or null when the item's own toast already said so. */
  reason: string | null;
}

/** A failure whose item helper already showed its own toast. */
export function reportedFailure(absPath: string): BatchFailure {
  return { name: basename(absPath), reason: null };
}

/** A failure that threw past the item helper, so nothing has explained it yet. */
export function thrownFailure(absPath: string, error: unknown): BatchFailure {
  return { name: basename(absPath), reason: fsErrorReason(error) };
}

/**
 * `key` is the message for a failure without a reason; `${key}Reason` is the
 * variant that appends one.
 */
export function partialFailureMessage(
  key: string,
  success: number,
  total: number,
  failure: BatchFailure,
): string {
  return failure.reason === null
    ? i18next.t(key, { success, total, name: failure.name })
    : i18next.t(`${key}Reason`, { success, total, name: failure.name, reason: failure.reason });
}
