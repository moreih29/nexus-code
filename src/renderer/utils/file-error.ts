import i18next from "i18next";
import { MAX_READABLE_FILE_SIZE } from "../../shared/fs/defaults";
import { FS_ERROR, type FsErrorCode } from "../../shared/fs/errors";
import { classifyFsError, FILE_ERROR_CODES, localizedFsError } from "./error-classification";

/**
 * Reader-side error mapping for the editor's "Open" path. Re-exports
 * the shared `FsErrorCode` plus an `OTHER` bucket for unknown messages
 * — the editor wants a friendly inline message rather than a toast, so
 * it doesn't share the toast helper in `services/fs-mutations/errors`.
 */
export type FileErrorCode = FsErrorCode | "OTHER";

export function parseFileErrorCode(message: string): FileErrorCode {
  return classifyFsError(message, FILE_ERROR_CODES) ?? "OTHER";
}

export function fileErrorMessage(
  code: FileErrorCode,
  maxMb: number = MAX_READABLE_FILE_SIZE / (1024 * 1024),
): string {
  switch (code) {
    case FS_ERROR.TOO_LARGE:
      return i18next.t("errors:open.TOO_LARGE", { maxMb });
    case "OTHER":
      return i18next.t("errors:open.failed");
    default:
      return localizedFsError(code);
  }
}

/**
 * User-facing reason for a failed fs operation: the localized phrase for the
 * error's FsErrorCode, leaving out the code and the absolute path its message
 * carries, or the message itself for an unclassified error.
 */
export function fsErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = parseFileErrorCode(message);
  return code === "OTHER" ? message : localizedFsError(code);
}
