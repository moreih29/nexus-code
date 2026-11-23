import { FS_ERROR } from "../../../shared/fs/errors";
import { type IpcErrResult, ipcErr } from "../../../shared/ipc/result";

export type FsIpcErrorResult = IpcErrResult<"fs-error">;

export function fsCallError(error: unknown): FsIpcErrorResult | undefined {
  if (!(error instanceof Error)) return;
  const { message } = error;
  const code = Object.values(FS_ERROR).find((value) => message.startsWith(`${value}:`));
  if (!code) return;
  return ipcErr("fs-error", message, { category: "failed", domain: "fs", code });
}
