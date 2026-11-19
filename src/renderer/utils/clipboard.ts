/**
 * Renderer-side clipboard helpers.
 *
 * Two paths, picked by call site:
 *
 *   • `copyText` — for click/keyboard-handler call sites (Git context menus,
 *     SSH dialog buttons, "Copy SHA" etc.).  Uses `navigator.clipboard.writeText`
 *     which works under the active user-gesture activation.
 *
 *   • `copyTextViaIpc` — for non-gesture call sites (xterm OSC 52 from a TUI,
 *     drag-selection without an explicit click, terminal keydown handlers that
 *     run before `attachCustomKeyEventHandler` returns).  Chromium's Async
 *     Clipboard API silently rejects these.  Routes through the main process
 *     `electron.clipboard.writeText` which has no activation gate.
 *
 */
import { appErrorFailed } from "../../shared/error/app-error";

export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

/** Writes through main and reports whether the clipboard received the text. */
export async function copyTextViaIpc(text: string): Promise<boolean> {
  try {
    const { ipcCallResult, unwrapIpcResult } = await import("../ipc/client");
    unwrapIpcResult(await ipcCallResult("clipboard", "writeText", { text }));
    return true;
  } catch (error) {
    // Lazy import because the error surface also offers a copy action.
    const { surfaceError } = await import("../services/error-surface/surface-error");
    surfaceError(appErrorFailed(String(error), { code: "clipboard-write-failed" }), {
      surface: "toast",
    });
    return false;
  }
}
