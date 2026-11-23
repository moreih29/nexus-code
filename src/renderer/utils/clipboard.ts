import { appErrorFailed } from "../../shared/error/app-error";

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

export async function copyTextViaIpc(text: string): Promise<boolean> {
  try {
    const { ipcCallResult, unwrapIpcResult } = await import("../ipc/client");
    unwrapIpcResult(await ipcCallResult("clipboard", "writeText", { text }));
    return true;
  } catch (error) {
    const { surfaceError } = await import("../services/error-surface/surface-error");
    surfaceError(appErrorFailed(String(error), { code: "clipboard-write-failed" }), {
      surface: "toast",
    });
    return false;
  }
}
