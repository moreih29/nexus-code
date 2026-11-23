import type * as Monaco from "monaco-editor";
import type { DirtyChange } from "./types";

const STYLE_ID = "nexus-dirty-diff-decorations";

const GLYPH = "nexus-dirty-diff-glyph";
const ADDED = "nexus-dirty-diff-added";
const MODIFIED = "nexus-dirty-diff-modified";
const DELETED = "nexus-dirty-diff-deleted";

export function injectDirtyDiffStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = [
    `.monaco-editor .${GLYPH} { margin-left: 3px; width: 3px !important; cursor: pointer; }`,
    `.monaco-editor .${GLYPH}.${ADDED} { border-left: 3px solid var(--git-status-added-fg); }`,
    `.monaco-editor .${GLYPH}.${MODIFIED} { border-left: 3px solid var(--git-status-modified-fg); }`,
    `.monaco-editor .${GLYPH}.${DELETED} { width: 0 !important; height: 0 !important; margin-left: 3px;` +
      ` border-left: 4px solid transparent; border-right: 4px solid transparent;` +
      ` border-top: 4px solid var(--git-status-deleted-fg); }`,
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

export function isDirtyDiffGlyphTarget(className: string | null | undefined): boolean {
  return typeof className === "string" && className.includes(GLYPH);
}
