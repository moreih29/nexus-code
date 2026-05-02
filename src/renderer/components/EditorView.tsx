// EditorView — Monaco editor wired to the LSP host via our IPC adapter.
// Props: filePath (absolute path), workspaceId (UUID).
//
// Architecture: @monaco-editor/react renders the editor. Monaco's built-in
// language provider hooks (registerHoverProvider, registerDefinitionProvider,
// registerCompletionItemProvider) delegate to ipcCall('lsp', ...) so the
// TypeScript language server in the lsp-host utility process serves results.
// Diagnostics are pushed via ipcListen('lsp', 'diagnostics', ...) and applied
// to the Monaco model marker API.

import { useEffect, useRef } from "react";
import Editor, { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { ipcCall, ipcListen } from "../ipc/client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filePathToUri(filePath: string): string {
  // Monaco uses file:// URIs
  return `file://${filePath}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EditorViewProps {
  filePath: string;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditorView({ filePath, workspaceId }: EditorViewProps) {
  const monaco = useMonaco();
  // Disposables accumulated during the mount so we can clean up on unmount
  const disposablesRef = useRef<Monaco.IDisposable[]>([]);
  const versionRef = useRef(1);
  const uri = filePathToUri(filePath);

  useEffect(() => {
    if (!monaco) return;

    const disposables = disposablesRef.current;

    // -----------------------------------------------------------------------
    // Hover provider
    // -----------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerHoverProvider("typescript", {
        async provideHover(model, position) {
          if (model.uri.toString() !== uri) return undefined;
          try {
            const result = await ipcCall("lsp", "hover", {
              uri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            if (!result) return undefined;
            return {
              contents: [{ value: result.contents }],
            };
          } catch {
            return undefined;
          }
        },
      })
    );

    // -----------------------------------------------------------------------
    // Definition provider
    // -----------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerDefinitionProvider("typescript", {
        async provideDefinition(model, position) {
          if (model.uri.toString() !== uri) return undefined;
          try {
            const results = await ipcCall("lsp", "definition", {
              uri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            if (!results || results.length === 0) return undefined;
            return results.map((loc) => ({
              uri: monaco.Uri.parse(loc.uri),
              range: {
                startLineNumber: loc.line + 1,
                startColumn: loc.character + 1,
                endLineNumber: loc.line + 1,
                endColumn: loc.character + 1,
              },
            }));
          } catch {
            return undefined;
          }
        },
      })
    );

    // -----------------------------------------------------------------------
    // Completion provider
    // -----------------------------------------------------------------------
    disposables.push(
      monaco.languages.registerCompletionItemProvider("typescript", {
        triggerCharacters: [".", '"', "'", "`", "/", "@", "<"],
        async provideCompletionItems(model, position) {
          if (model.uri.toString() !== uri) return { suggestions: [] };
          try {
            const results = await ipcCall("lsp", "completion", {
              uri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            });
            const word = model.getWordUntilPosition(position);
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            };
            return {
              suggestions: results.map((item) => ({
                label: item.label,
                kind: item.kind ?? monaco.languages.CompletionItemKind.Text,
                insertText: item.label,
                range,
              })),
            };
          } catch {
            return { suggestions: [] };
          }
        },
      })
    );

    // -----------------------------------------------------------------------
    // Diagnostics listener
    // -----------------------------------------------------------------------
    const unlistenDiagnostics = ipcListen("lsp", "diagnostics", (args) => {
      if (args.uri !== uri) return;
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!model) return;
      monaco.editor.setModelMarkers(
        model,
        "lsp",
        args.diagnostics.map((d) => ({
          startLineNumber: d.line + 1,
          startColumn: d.character + 1,
          endLineNumber: d.line + 1,
          endColumn: d.character + 2,
          message: d.message,
          severity: d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
            ? monaco.MarkerSeverity.Warning
            : monaco.MarkerSeverity.Info,
        }))
      );
    });

    return () => {
      unlistenDiagnostics();
      for (const d of disposables) {
        d.dispose();
      }
      disposablesRef.current = [];
    };
  }, [monaco, uri, workspaceId]);

  // Send didOpen when the model is created / file first loaded
  function handleEditorDidMount(
    _editor: Monaco.editor.IStandaloneCodeEditor,
    monacoInstance: typeof Monaco
  ): void {
    const model = monacoInstance.editor.getModel(monacoInstance.Uri.parse(uri));
    if (!model) return;
    ipcCall("lsp", "didOpen", {
      workspaceId,
      uri,
      languageId: "typescript",
      version: versionRef.current,
      text: model.getValue(),
    }).catch(() => {});
  }

  function handleChange(value: string | undefined): void {
    if (value === undefined) return;
    versionRef.current += 1;
    ipcCall("lsp", "didChange", {
      uri,
      version: versionRef.current,
      text: value,
    }).catch(() => {});
  }

  return (
    <Editor
      height="100%"
      defaultLanguage="typescript"
      path={uri}
      onMount={handleEditorDidMount}
      onChange={handleChange}
      theme="vs-dark"
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "monospace",
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
