/**
 * Workspace-agnostic application window handlers.
 */

/**
 * Builds the handler used by clone's "Open in new window" CTA. The callback is
 * injected from main/index.ts to keep this IPC channel free of BrowserWindow
 * construction details.
 */
export function openNewWindowHandler(openWindow: () => unknown): () => { ok: true } {
  return () => {
    openWindow();
    return { ok: true };
  };
}
