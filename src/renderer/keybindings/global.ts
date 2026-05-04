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
  splitActiveGroup?: (orientation: "horizontal" | "vertical") => void;
  closeActiveGroup?: () => void;
  moveFocus?: (direction: "left" | "right" | "up" | "down") => void;
}

/**
 * Returns true if the event target is an editable element where global file
 * open shortcuts should not fire (input, textarea, contenteditable, or inside
 * .cm-editor).
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

  // Cmd+E / Cmd+O — open file picker to add an EditorView tab.
  // Skipped when the event originates inside an editable element so as not to
  // interrupt text-editing workflows.
  if (e.metaKey && (e.key === "e" || e.key === "o")) {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    const wsId = deps.getActiveWorkspaceId();
    if (!wsId) return;
    deps.openFileDialog(wsId).catch(() => {});
    return;
  }

  // Cmd+\ — split active group right (horizontal split, after)
  // e.code used for Korean keyboard compatibility (Backslash or Slash)
  if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && (e.code === "Backslash" || e.code === "Slash")) {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    deps.splitActiveGroup?.("horizontal");
    return;
  }

  // Cmd+Shift+\ (or Cmd+Shift+|) — split active group down (vertical split, after)
  // e.code used for Korean keyboard compatibility (Backslash or Slash)
  if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && (e.code === "Backslash" || e.code === "Slash")) {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    deps.splitActiveGroup?.("vertical");
    return;
  }

  // Cmd+Shift+W — close active group
  if (e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey && (e.key === "w" || e.key === "W")) {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    deps.closeActiveGroup?.();
    return;
  }

  // Cmd+Alt+Arrow — move focus between groups
  if (e.metaKey && e.altKey && !e.ctrlKey) {
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowDown"
    ) {
      if (isInEditable(e.target as HTMLElement | null)) return;
      e.preventDefault();
      const dirMap: Record<string, "left" | "right" | "up" | "down"> = {
        ArrowLeft: "left",
        ArrowRight: "right",
        ArrowUp: "up",
        ArrowDown: "down",
      };
      deps.moveFocus?.(dirMap[e.key]);
    }
  }
}
