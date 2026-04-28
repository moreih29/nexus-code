import { useEffect, useRef, useState } from "react";

import { ArrowDown, ArrowUp, Columns2, Rows3 } from "lucide-react";

import type { EditorDiffSide } from "../services/editor-model-service";
import { Button } from "./ui/button";

export interface DiffEditorHostProps {
  left: EditorDiffSide;
  right: EditorDiffSide;
}

type MonacoApi = typeof import("monaco-editor");
type MonacoDiffEditor = import("monaco-editor").editor.IStandaloneDiffEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;

export function DiffEditorHost({ left, right }: DiffEditorHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<MonacoDiffEditor | null>(null);
  const modelsRef = useRef<{ original: MonacoModel; modified: MonacoModel } | null>(null);
  const [renderSideBySide, setRenderSideBySide] = useState(true);

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide });
  }, [renderSideBySide]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    void import("monaco-editor").then((monaco) => {
      if (disposed) {
        return;
      }

      defineNexusDiffTheme(monaco);
      const original = monaco.editor.createModel(
        left.content,
        left.monacoLanguage,
        createDiffModelUri(monaco, left, "left"),
      );
      const modified = monaco.editor.createModel(
        right.content,
        right.monacoLanguage,
        createDiffModelUri(monaco, right, "right"),
      );
      const editor = monaco.editor.createDiffEditor(host, {
        theme: "nexus-dark",
        automaticLayout: true,
        renderSideBySide: true,
        readOnly: true,
        originalEditable: false,
        minimap: { enabled: false },
        fontFamily: "var(--font-mono)",
        fontLigatures: false,
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: "selection",
      });
      editor.setModel({ original, modified });
      editor.addCommand(monaco.KeyCode.KeyJ, () => editor.goToDiff("next"));
      editor.addCommand(monaco.KeyCode.KeyK, () => editor.goToDiff("previous"));
      editorRef.current = editor;
      modelsRef.current = { original, modified };
    });

    return () => {
      disposed = true;
      editorRef.current?.dispose();
      modelsRef.current?.original.dispose();
      modelsRef.current?.modified.dispose();
      editorRef.current = null;
      modelsRef.current = null;
    };
  }, [left, right]);

  return (
    <section
      data-component="diff-editor-host"
      role="region"
      aria-label={diffEditorAriaLabel(left.path, right.path)}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <header className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-xs">
        <div className="min-w-0 truncate font-mono text-muted-foreground">
          <span className="text-foreground">Read-only diff</span> · {left.path} ↔ {right.path}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            data-action="diff-toggle-layout"
            variant="outline"
            size="xs"
            aria-pressed={!renderSideBySide}
            onClick={() => setRenderSideBySide((current) => !current)}
          >
            {renderSideBySide ? <Rows3 aria-hidden="true" className="size-3" /> : <Columns2 aria-hidden="true" className="size-3" />}
            {diffEditorLayoutLabel(renderSideBySide)}
          </Button>
          <Button
            type="button"
            data-action="diff-previous-change"
            variant="ghost"
            size="xs"
            onClick={() => editorRef.current?.goToDiff("previous")}
          >
            <ArrowUp aria-hidden="true" className="size-3" />
            Prev
          </Button>
          <Button
            type="button"
            data-action="diff-next-change"
            variant="ghost"
            size="xs"
            onClick={() => editorRef.current?.goToDiff("next")}
          >
            <ArrowDown aria-hidden="true" className="size-3" />
            Next
          </Button>
        </div>
      </header>
      <div
        ref={hostRef}
        data-diff-editor-surface="true"
        data-left-path={left.path}
        data-right-path={right.path}
        className="min-h-0 flex-1 overflow-hidden"
      />
    </section>
  );
}

export function diffEditorAriaLabel(leftPath: string, rightPath: string): string {
  return `Diff: ${leftPath} versus ${rightPath}`;
}

export function diffEditorLayoutLabel(renderSideBySide: boolean): string {
  return renderSideBySide ? "Inline" : "Side-by-side";
}

function defineNexusDiffTheme(monaco: MonacoApi): void {
  monaco.editor.defineTheme("nexus-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#09090b",
      "editor.foreground": "#f4f4f5",
      "editorLineNumber.foreground": "#71717a",
      "editorCursor.foreground": "#3aa0a6",
      "editor.selectionBackground": "#164e63",
      "editor.inactiveSelectionBackground": "#27272a",
      "editor.lineHighlightBackground": "#18181b",
      "editorWidget.background": "#18181b",
      "editorWidget.border": "#27272a",
      focusBorder: "#3aa0a6",
    },
  });
}

function createDiffModelUri(
  monaco: MonacoApi,
  side: EditorDiffSide,
  sideName: "left" | "right",
): import("monaco-editor").Uri {
  const workspacePart = encodeURIComponent(side.workspaceId);
  const pathPart = side.path.split("/").map(encodeURIComponent).join("/");
  return monaco.Uri.parse(`nexus-diff://${workspacePart}/${pathPart}?side=${sideName}`);
}
