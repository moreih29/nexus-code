import { useEffect, useRef } from "react";

import type { E4Diagnostic } from "../../../../shared/src/contracts/e4-editor";
import { mapE4DiagnosticsToMonacoMarkers } from "../monaco-lsp-markers";

export interface MonacoEditorHostProps {
  workspaceId: string;
  path: string;
  languageId: string;
  value: string;
  diagnostics: E4Diagnostic[];
  onChange(value: string): void;
}

type MonacoApi = typeof import("monaco-editor");
type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;

const MARKER_OWNER = "nexus-e4-lsp";

export function MonacoEditorHost({
  workspaceId,
  path,
  languageId,
  value,
  diagnostics,
  onChange,
}: MonacoEditorHostProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const modelRef = useRef<MonacoModel | null>(null);
  const suppressChangeRef = useRef(false);
  const valueRef = useRef(value);
  const diagnosticsRef = useRef(diagnostics);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    valueRef.current = value;
    const model = modelRef.current;
    if (!model || model.getValue() === value) {
      return;
    }

    suppressChangeRef.current = true;
    model.setValue(value);
    suppressChangeRef.current = false;
  }, [value]);

  useEffect(() => {
    diagnosticsRef.current = diagnostics;
    applyMarkers(monacoRef.current, modelRef.current, diagnostics);
  }, [diagnostics]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    let disposed = false;
    let contentDisposable: MonacoDisposable | null = null;

    void import("monaco-editor").then((monaco) => {
      if (disposed) {
        return;
      }

      monacoRef.current = monaco;
      defineNexusTheme(monaco);
      const model = monaco.editor.createModel(
        valueRef.current,
        languageId,
        createMonacoUri(monaco, workspaceId, path),
      );
      const editor = monaco.editor.create(host, {
        model,
        theme: "nexus-dark",
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "var(--font-mono)",
        fontLigatures: false,
        fontSize: 13,
        lineHeight: 20,
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: "selection",
      });

      contentDisposable = editor.onDidChangeModelContent(() => {
        if (!suppressChangeRef.current) {
          onChangeRef.current(model.getValue());
        }
      });

      installFindReplaceKeybindings(monaco, editor);
      monaco.editor.setModelLanguage(model, languageId);
      applyMarkers(monaco, model, diagnosticsRef.current);
      editorRef.current = editor;
      modelRef.current = model;
    });

    return () => {
      disposed = true;
      contentDisposable?.dispose();
      monacoRef.current?.editor.setModelMarkers(modelRef.current, MARKER_OWNER, []);
      editorRef.current?.dispose();
      modelRef.current?.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [languageId, path, workspaceId]);

  return (
    <div
      ref={hostRef}
      data-component="monaco-editor-host"
      data-file-path={path}
      className="h-full min-h-0 w-full overflow-hidden"
    />
  );
}

function defineNexusTheme(monaco: MonacoApi): void {
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
      "focusBorder": "#3aa0a6",
    },
  });
}

function installFindReplaceKeybindings(monaco: MonacoApi, editor: MonacoEditor): void {
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
    void editor.getAction("actions.find")?.run();
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH, () => {
    void editor.getAction("editor.action.startFindReplaceAction")?.run();
  });
}

function applyMarkers(
  monaco: MonacoApi | null,
  model: MonacoModel | null,
  diagnostics: readonly E4Diagnostic[],
): void {
  if (!monaco || !model) {
    return;
  }

  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    mapE4DiagnosticsToMonacoMarkers(diagnostics, monaco.MarkerSeverity),
  );
}

function createMonacoUri(monaco: MonacoApi, workspaceId: string, filePath: string) {
  const normalizedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return monaco.Uri.parse(`file:///nexus/${encodeURIComponent(workspaceId)}/${normalizedPath}`);
}
