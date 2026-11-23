export const FS_ERROR = {
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  IS_DIRECTORY: "IS_DIRECTORY",
  NOT_DIRECTORY: "NOT_DIRECTORY",
  TOO_LARGE: "TOO_LARGE",
  TRANSFER_TOO_LARGE: "TRANSFER_TOO_LARGE",
  OUT_OF_WORKSPACE: "OUT_OF_WORKSPACE",
  STALE: "STALE",
  NOT_EMPTY: "NOT_EMPTY",
  CROSS_DEVICE: "CROSS_DEVICE",
  NO_SPACE: "NO_SPACE",
  UNSUPPORTED_REMOTE: "UNSUPPORTED_REMOTE",
} as const;

export type FsErrorCode = (typeof FS_ERROR)[keyof typeof FS_ERROR];

export function fsErrorMessage(code: FsErrorCode, suffix: string): string {
  return `${code}: ${suffix}`;
}

export function fsCodeFromErrno(errno: string | undefined): FsErrorCode | null {
  switch (errno) {
    case "ENOENT":
      return FS_ERROR.NOT_FOUND;
    case "EACCES":
      return FS_ERROR.PERMISSION_DENIED;
    case "EEXIST":
      return FS_ERROR.ALREADY_EXISTS;
    case "ENOTDIR":
      return FS_ERROR.NOT_DIRECTORY;
    case "ENOTEMPTY":
      return FS_ERROR.NOT_EMPTY;
    case "EXDEV":
      return FS_ERROR.CROSS_DEVICE;
    default:
      return null;
  }
}

export function hasFsErrorCode(error: unknown, code: FsErrorCode): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith(`${code}:`)) return true;
  return new RegExp(`(?:^|\\bError:\\s)${code}:`).test(raw);
}
