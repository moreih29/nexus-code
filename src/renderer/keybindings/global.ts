/**
 * Global keyboard shortcut handler for the app window.
 *
 * Extracted from App.tsx useEffect so it can be unit-tested without a DOM/React
 * environment. All external dependencies are injected via `GlobalKeyDeps`.
 */

export interface GlobalKeyDeps {
  getActiveWorkspaceId: () => string | null;
  refresh: (wsId: string) => Promise<void>;
  openFileDialog: (wsId: string) => Promise<void>;
}

/**
 * Returns true if the event target is an editable element where Cmd+E should
 * not fire (input, textarea, contenteditable, or inside .cm-editor).
 *
 * Exported for unit testing.
 */
export function isInEditable(target: HTMLElement | null): boolean {
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true ||
    target?.closest(".cm-editor") != null
  );
}

export function handleGlobalKeyDown(e: KeyboardEvent, deps: GlobalKeyDeps): void {
  // Cmd+R or Cmd+Shift+R — refresh active workspace file tree, block page reload.
  if (e.metaKey && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    const wsId = deps.getActiveWorkspaceId();
    if (wsId) {
      deps.refresh(wsId).catch(() => {});
    }
    return;
  }

  // Cmd+E — open file picker to add an EditorView tab.
  // Skipped when the event originates inside an editable element so as not to
  // interrupt text-editing workflows.
  if (e.metaKey && e.key === "e") {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    const wsId = deps.getActiveWorkspaceId();
    if (!wsId) return;
    deps.openFileDialog(wsId).catch(() => {});
  }
}
