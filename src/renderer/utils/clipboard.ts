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
 * Failure modes (permission denied, document not focused for the navigator
 * path; IPC dropped for the IPC path) surface as silent rejections — copy is
 * non-destructive and the user notices missing paste content quickly. When we
 * add a toast channel for other actions (Reveal in Finder, Rename, Delete)
 * these helpers are the single place to wire failure feedback.
 */
export function copyText(text: string): void {
  void navigator.clipboard.writeText(text);
}

export function copyTextViaIpc(text: string): void {
  // Lazy import to keep the helper testable without the IPC bridge — matches
  // the lazy pattern in `services/error-surface/surface-error.ts`.
  void import("../ipc/client").then(({ ipcCallResult }) =>
    ipcCallResult("clipboard", "writeText", { text }),
  );
}
