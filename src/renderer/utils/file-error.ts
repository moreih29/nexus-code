import i18next from "i18next";
import { MAX_READABLE_FILE_SIZE } from "../../shared/fs/defaults";
import { FS_ERROR, type FsErrorCode } from "../../shared/fs/errors";
import { classifyFsError, FILE_ERROR_CODES, localizedFsError } from "./error-classification";

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

export function fsErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = parseFileErrorCode(message);
  return code === "OTHER" ? message : localizedFsError(code);
}
