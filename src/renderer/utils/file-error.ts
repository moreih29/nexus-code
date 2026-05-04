import { MAX_READABLE_FILE_SIZE } from "../../shared/fs-defaults";

export type FileErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "IS_DIRECTORY"
  | "TOO_LARGE"
  | "OTHER";

export function parseFileErrorCode(message: string): FileErrorCode {
  const match = /(?:^|\bError:\s)(NOT_FOUND|PERMISSION_DENIED|IS_DIRECTORY|TOO_LARGE):/.exec(
    message,
  );
  if (!match) return "OTHER";
  return match[1] as FileErrorCode;
}

export function fileErrorMessage(
  code: FileErrorCode,
  maxMb: number = MAX_READABLE_FILE_SIZE / (1024 * 1024),
): string {
  switch (code) {
    case "NOT_FOUND":
      return "File not found.";
    case "PERMISSION_DENIED":
      return "Permission denied.";
    case "IS_DIRECTORY":
      return "Cannot open a directory.";
    case "TOO_LARGE":
      return `File too large to open (max ${maxMb} MB).`;
    case "OTHER":
      return "Failed to open file.";
  }
}
