/**
 * Shared error codes for fs IPC handlers.
 *
 * The main process throws `Error("CODE: <abs path>")` strings (the
 * Electron IPC bridge serialises Errors by message). The renderer
 * matches on the prefix to decide which user-facing toast to show.
 * Both sides import these constants so a typo on either end becomes a
 * type error rather than a silent miss.
 */

export const FS_ERROR = {
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  IS_DIRECTORY: "IS_DIRECTORY",
  TOO_LARGE: "TOO_LARGE",
  OUT_OF_WORKSPACE: "OUT_OF_WORKSPACE",
} as const;

export type FsErrorCode = (typeof FS_ERROR)[keyof typeof FS_ERROR];

/** Build the `"CODE: <suffix>"` message thrown from main-process handlers. */
export function fsErrorMessage(code: FsErrorCode, suffix: string): string {
  return `${code}: ${suffix}`;
}

/**
 * Map a Node.js errno (`ENOENT`, `EACCES`, `EEXIST`) to our shared
 * `FsErrorCode`. Returns null for codes we don't translate so callers
 * can re-throw the original error untouched.
 */
export function fsCodeFromErrno(errno: string | undefined): FsErrorCode | null {
  switch (errno) {
    case "ENOENT":
      return FS_ERROR.NOT_FOUND;
    case "EACCES":
      return FS_ERROR.PERMISSION_DENIED;
    case "EEXIST":
      return FS_ERROR.ALREADY_EXISTS;
    default:
      return null;
  }
}

/**
 * True when the error message carries the given fs code as its prefix —
 * either at the very start (`"NOT_FOUND: ..."`) or right after Electron's
 * remote-method wrapper (`"... Error: NOT_FOUND: ..."`). The strict prefix
 * shape avoids matching a code embedded mid-message (e.g. an English
 * sentence that happens to contain the word).
 */
export function hasFsErrorCode(error: unknown, code: FsErrorCode): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith(`${code}:`)) return true;
  return new RegExp(`(?:^|\\bError:\\s)${code}:`).test(raw);
}
