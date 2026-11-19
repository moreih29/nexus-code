import i18next from "i18next";
import { FS_ERROR, type FsErrorCode, hasFsErrorCode } from "../../shared/fs/errors";
import { isRecord } from "./is-record";

/** File-read codes in the order the legacy message parser checks them. */
export const FILE_ERROR_CODES: readonly FsErrorCode[] = [
  FS_ERROR.NOT_FOUND,
  FS_ERROR.PERMISSION_DENIED,
  FS_ERROR.IS_DIRECTORY,
  FS_ERROR.TOO_LARGE,
  FS_ERROR.ALREADY_EXISTS,
  FS_ERROR.OUT_OF_WORKSPACE,
  FS_ERROR.NOT_EMPTY,
  FS_ERROR.NOT_DIRECTORY,
  FS_ERROR.CROSS_DEVICE,
  FS_ERROR.NO_SPACE,
  FS_ERROR.UNSUPPORTED_REMOTE,
];

/** Classify a legacy FS message in the caller's supported-code order. */
export function classifyFsError<Code extends FsErrorCode>(
  error: unknown,
  codes: readonly Code[],
): Code | undefined {
  return codes.find((code) => hasFsErrorCode(error, code));
}

/** Localizes an FS code in the common error namespace. */
export function localizedFsError(code: FsErrorCode): string {
  return i18next.t(`errors:fs.${code}`);
}

/** Maps the FS codes that the common error surface recognizes. */
export function knownFsErrorMessage(code: string): string | undefined {
  const known = FILE_ERROR_CODES.find((candidate) => candidate === code);
  return known === undefined ? undefined : localizedFsError(known);
}

/** Extracts the display message and selects the caller's fallback for missing Git kinds. */
export function classifyGitError(
  error: unknown,
  fallback: "unknown" | "name" = "unknown",
): { kind: string; message: string } {
  if (!isRecord(error)) return { kind: "unknown", message: String(error) };
  return {
    kind:
      typeof error.kind === "string"
        ? error.kind
        : fallback === "name" && typeof error.name === "string"
          ? error.name
          : "unknown",
    message:
      typeof error.message === "string" ? error.message : i18next.t("files:git.gitOperationFailed"),
  };
}
