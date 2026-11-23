import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { type LineRange, lineChangeOfMonaco, selectedLineRange } from "./line-changes";
import { stageLines, unstageLines } from "./stage-lines";

export type DiffStaging =
  | { kind: "stage"; workspaceId: string; relPath: string }
  | { kind: "unstage"; workspaceId: string; relPath: string; headRelPath: string };

const GLYPH = "nexus-diff-stage-glyph";
const STYLE_ID = "nexus-diff-stage-styles";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `.monaco-editor .${GLYPH} { cursor: pointer; opacity: 0.6; }` +
    `.monaco-editor .${GLYPH}:hover { opacity: 1; }`;
  document.head.appendChild(style);
}

export function installDiffStaging(
  diffEditor: Monaco.editor.IStandaloneDiffEditor,
  monaco: typeof Monaco,
  staging: DiffStaging,
): Monaco.IDisposable {
  injectStyles();
  const modified = diffEditor.getModifiedEditor();
  const staged = staging.kind === "unstage";
  const changeLabel = i18next.t(staged ? "editor.diff_unstage_change" : "editor.diff_stage_change");
  const rangesLabel = i18next.t(
    staged ? "editor.diff_unstage_selected_ranges" : "editor.diff_stage_selected_ranges",
  );

  modified.updateOptions({ glyphMargin: true });
  const decorations = modified.createDecorationsCollection([]);
  let changes: { anchor: number; lines: LineRange }[] = [];

  const paint = () => {
    changes = (diffEditor.getLineChanges() ?? []).map((change) => {
      const lines = lineChangeOfMonaco(change).modified;
      const deletion = lines.startLineNumber === lines.endLineNumberExclusive;
      return {
        anchor: deletion ? Math.max(1, lines.startLineNumber - 1) : lines.startLineNumber,
        lines,
      };
    });
    decorations.set(
      changes.map(({ anchor }) => ({
        range: new monaco.Range(anchor, 1, anchor, 1),
        options: {
          glyphMarginClassName: `codicon codicon-${staged ? "remove" : "add"} ${GLYPH}`,
          glyphMarginHoverMessage: { value: changeLabel },
        },
      })),
    );
  };

  const run = (ranges: readonly LineRange[]) => {
    const model = modified.getModel();
    if (!model || ranges.length === 0) return;
    const text = model.getValue();
    if (staging.kind === "stage") {
      const { workspaceId, relPath } = staging;
      void stageLines({ workspaceId, relPath, working: text, eol: model.getEOL(), ranges });
    } else {
      const { workspaceId, relPath, headRelPath } = staging;
      void unstageLines({ workspaceId, relPath, headRelPath, index: text, ranges });
    }
  };

  const listeners = [
    diffEditor.onDidUpdateDiff(paint),
    modified.onMouseDown((event) => {
      if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      if (!(event.target.element as HTMLElement | null)?.classList.contains(GLYPH)) return;
      const line = event.target.position?.lineNumber;
      const change = changes.find(({ anchor }) => anchor === line);
      if (change) run([change.lines]);
    }),
    modified.addAction({
      id: `nexus.git.${staging.kind}SelectedRanges`,
      label: rangesLabel,
      contextMenuGroupId: "1_git",
      run: (editor) => run((editor.getSelections() ?? []).map(selectedLineRange)),
    }),
  ];
  paint();

  return {
    dispose() {
      for (const listener of listeners) listener.dispose();
      decorations.clear();
      modified.updateOptions({ glyphMargin: false });
    },
  };
}
