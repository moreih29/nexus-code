import { MAX_READABLE_FILE_SIZE } from "../../shared/fs-defaults";
import { FS_ERROR, type FsErrorCode, hasFsErrorCode } from "../../shared/fs-errors";

/**
 * Reader-side error mapping for the editor's "Open" path. Re-exports
 * the shared `FsErrorCode` plus an `OTHER` bucket for unknown messages
 * — the editor wants a friendly inline message rather than a toast, so
 * it doesn't share the toast helper in `services/fs-mutations/errors`.
 */
export type FileErrorCode = FsErrorCode | "OTHER";

export function parseFileErrorCode(message: string): FileErrorCode {
  const candidates: FsErrorCode[] = [
    FS_ERROR.NOT_FOUND,
    FS_ERROR.PERMISSION_DENIED,
    FS_ERROR.IS_DIRECTORY,
    FS_ERROR.TOO_LARGE,
    FS_ERROR.ALREADY_EXISTS,
    FS_ERROR.OUT_OF_WORKSPACE,
  ];
  for (const code of candidates) {
    if (hasFsErrorCode(message, code)) return code;
  }
  return "OTHER";
}

export function fileErrorMessage(
  code: FileErrorCode,
  maxMb: number = MAX_READABLE_FILE_SIZE / (1024 * 1024),
): string {
  switch (code) {
    case FS_ERROR.NOT_FOUND:
      return "File not found.";
    case FS_ERROR.PERMISSION_DENIED:
      return "Permission denied.";
    case FS_ERROR.IS_DIRECTORY:
      return "Cannot open a directory.";
    case FS_ERROR.TOO_LARGE:
      return `File too large to open (max ${maxMb} MB).`;
    case FS_ERROR.ALREADY_EXISTS:
      return "Already exists.";
    case FS_ERROR.OUT_OF_WORKSPACE:
      return "This path is outside the workspace.";
    case "OTHER":
      return "Failed to open file.";
  }
}
