/**
 * Translates computed {@link DirtyChange}s into Monaco gutter decorations and
 * injects the CSS that paints the coloured bars.
 *
 * Visual model mirrors VSCode's dirty-diff:
 *   - added / modified : a 3px coloured bar in the line-number gutter spanning
 *     the changed lines, plus an overview-ruler tick and minimap tick.
 *   - deleted          : a small triangle anchored to the line above the gap.
 *
 * Colours reuse the app-wide `--git-status-*-fg` theme variables so the gutter,
 * the file tree, and the status bar all agree per theme. The gutter bar reads
 * the variable directly via CSS; the overview-ruler/minimap ticks are painted
 * on a canvas (no CSS cascade), so we resolve the variable to a concrete colour
 * at build time.
 */

import type * as Monaco from "monaco-editor";
import type { DirtyChange } from "./types";

const STYLE_ID = "nexus-dirty-diff-decorations";

const GLYPH = "nexus-dirty-diff-glyph";
const ADDED = "nexus-dirty-diff-added";
const MODIFIED = "nexus-dirty-diff-modified";
const DELETED = "nexus-dirty-diff-deleted";

/**
 * Injects the gutter styles once per document. Idempotent — guarded on the
 * style element id, mirroring the conflict-decoration injector.
 */
export function injectDirtyDiffStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    // The glyph sits in the lines-decorations gutter column. A left border is
    // the coloured bar; width 0 keeps the cell narrow. `cursor:pointer` signals
    // the click-to-peek affordance.
    `.monaco-editor .${GLYPH} { margin-left: 3px; width: 3px !important; cursor: pointer; }`,
    `.monaco-editor .${GLYPH}.${ADDED} { border-left: 3px solid var(--git-status-added-fg); }`,
    `.monaco-editor .${GLYPH}.${MODIFIED} { border-left: 3px solid var(--git-status-modified-fg); }`,
    // Deletions have no lines to span, so render a downward triangle hanging
    // off the bottom of the anchor line instead of a vertical bar.
    `.monaco-editor .${GLYPH}.${DELETED} { width: 0 !important; height: 0 !important; margin-left: 3px;` +
      ` border-left: 4px solid transparent; border-right: 4px solid transparent;` +
      ` border-top: 4px solid var(--git-status-deleted-fg); }`,
    // Peek panel: an overlay widget pinned to the viewport, hosting a header
    // bar + embedded diff editor. box-sizing keeps the borders inside the width
    // set in JS; the opaque background hides the editor text behind it.
    `.nexus-dirty-diff-peek { box-sizing: border-box; overflow: hidden; z-index: 12;` +
      ` border-top: 1px solid var(--surface-floating-border, #30363d);` +
      ` border-bottom: 1px solid var(--surface-floating-border, #30363d);` +
      ` background: var(--surface-island-bg, #1e1e1e); }`,
    `.nexus-dirty-diff-peek-header { display: flex; align-items: center; justify-content: space-between;` +
      ` height: 26px; padding: 0 8px; font-size: 12px; box-sizing: border-box;` +
      ` color: var(--surface-island-fg, inherit); background: rgba(127, 127, 127, 0.08); }`,
    `.nexus-dirty-diff-peek-label { opacity: 0.85; }`,
    `.nexus-dirty-diff-peek-actions { display: flex; gap: 2px; }`,
    `.nexus-dirty-diff-peek-btn { display: inline-flex; align-items: center; justify-content: center;` +
      ` width: 20px; height: 20px; background: transparent; border: none; color: inherit;` +
      ` cursor: pointer; border-radius: 3px; padding: 0; }`,
    `.nexus-dirty-diff-peek-btn:hover { background: rgba(127, 127, 127, 0.2); }`,
  ].join("\n");
  document.head.appendChild(style);
}

/** Resolves a CSS custom property to its concrete value for canvas painting. */
function resolveCssVar(name: string): string {
  if (typeof document === "undefined") return "#888888";
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || "#888888";
}

function clamp(line: number, max: number): number {
  if (line < 1) return 1;
  if (line > max) return max;
  return line;
}

/**
 * Builds the delta-decoration array for the given changes against `model`.
 * Line numbers are clamped to the model so a stale change set (computed just
 * before an edit) can never produce an out-of-range decoration.
 */
export function buildDirtyDiffDecorations(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  changes: DirtyChange[],
): Monaco.editor.IModelDeltaDecoration[] {
  const lineCount = model.getLineCount();
  const addedColor = resolveCssVar("--git-status-added-fg");
  const modifiedColor = resolveCssVar("--git-status-modified-fg");
  const deletedColor = resolveCssVar("--git-status-deleted-fg");

  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];

  for (const change of changes) {
    if (change.type === "delete") {
      // No modified lines exist; anchor the triangle to the line above the gap
      // so it reads as "content was removed after this line".
      const anchor = clamp(change.modifiedStartLineNumber - 1, lineCount);
      decorations.push({
        range: new monaco.Range(anchor, 1, anchor, 1),
        options: {
          linesDecorationsClassName: `${GLYPH} ${DELETED}`,
          overviewRuler: {
            color: deletedColor,
            position: monaco.editor.OverviewRulerLane.Left,
          },
        },
      });
      continue;
    }

    const start = clamp(change.modifiedStartLineNumber, lineCount);
    const end = clamp(change.modifiedEndLineNumber || change.modifiedStartLineNumber, lineCount);
    const isAdd = change.type === "add";

    decorations.push({
      range: new monaco.Range(start, 1, end, 1),
      options: {
        isWholeLine: true,
        linesDecorationsClassName: `${GLYPH} ${isAdd ? ADDED : MODIFIED}`,
        overviewRuler: {
          color: isAdd ? addedColor : modifiedColor,
          position: monaco.editor.OverviewRulerLane.Left,
        },
        minimap: {
          color: isAdd ? addedColor : modifiedColor,
          position: monaco.editor.MinimapPosition.Gutter,
        },
      },
    });
  }

  return decorations;
}

/** Returns true when the click landed on a dirty-diff gutter glyph. */
export function isDirtyDiffGlyphTarget(className: string | null | undefined): boolean {
  return typeof className === "string" && className.includes(GLYPH);
}
