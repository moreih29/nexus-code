import i18next from "i18next";
import { showToast } from "@/components/ui/toast";
import { FS_ERROR } from "../../../shared/fs/errors";
import { isAppError } from "../../hooks/use-ipc-action";
import { classifyFsError } from "../../utils/error-classification";
import { surfaceError } from "../error-surface/surface-error";

export interface FsToastMessages {
  fallback: string;
  alreadyExists?: string;
  notFound?: string;
  permissionDenied?: string;
  notEmpty?: string;
  notDirectory?: string;
  crossDevice?: string;
  unsupportedRemote?: string;
}

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

export function toFsToast(error: unknown, msgs: FsToastMessages): void {
  if (isAppError(error) && (error.category !== "failed" || error.domain !== "fs")) {
    surfaceError(error, { surface: "auto" });
    return;
  }

  const code = classifyFsError(error, MUTATION_CODES);
  const key = code === undefined ? undefined : MESSAGE_OVERRIDES[code];
  showToast({
    kind: code === FS_ERROR.NOT_EMPTY ? "warning" : "error",
    message:
      key === undefined ? msgs.fallback : (msgs[key] ?? i18next.t(`files:fileTree.fsError.${key}`)),
  });
}
