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
  /**
   * Save the active editor tab's buffer. No-op when there is no active
   * editor (e.g. focus is in the file tree, the active tab is a
   * terminal, or no workspace is active). The action runs only when
   * monaco didn't already handle the keystroke via its own keybinding —
   * see `isInEditable`.
   */
  saveActiveEditor?: () => void;
}

/**
 * Returns true if the event target is an editable element where global file
 * open shortcuts should not fire (input, textarea, contenteditable, inside
 * .cm-editor, or inside a monaco editor — monaco's own textarea sits
 * under `.monaco-editor` and registers its own keybindings).
 *
 * Exported for unit testing.
 */
export function isInEditable(target: HTMLElement | null): boolean {
  return (
    target?.tagName === "INPUT" ||
    target?.tagName === "TEXTAREA" ||
    target?.isContentEditable === true ||
    target?.closest(".cm-editor") != null ||
    target?.closest(".monaco-editor") != null
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
  if (
    e.metaKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    (e.code === "Backslash" || e.code === "Slash")
  ) {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    deps.splitActiveGroup?.("horizontal");
    return;
  }

  // Cmd+Shift+\ (or Cmd+Shift+|) — split active group down (vertical split, after)
  // e.code used for Korean keyboard compatibility (Backslash or Slash)
  if (
    e.metaKey &&
    e.shiftKey &&
    !e.altKey &&
    !e.ctrlKey &&
    (e.code === "Backslash" || e.code === "Slash")
  ) {
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

  // Cmd/Ctrl+S — save active editor tab. Skipped when focus is inside
  // a monaco editor (handled by editor.addAction so no double-save) or
  // any other editable element. e.code is used (not e.key) for the
  // same Korean-keyboard reason as the split shortcuts above — when
  // IME is engaged, e.key may surface a Hangul jamo instead of "s".
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === "KeyS") {
    if (isInEditable(e.target as HTMLElement | null)) return;
    e.preventDefault();
    deps.saveActiveEditor?.();
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
