// EditorView — Monaco editor wired to the LSP host via our IPC adapter.
// Props: filePath (absolute path), workspaceId (UUID).
//
// Architecture: @monaco-editor/react renders the editor. Monaco's built-in
// language provider hooks (registerHoverProvider, registerDefinitionProvider,
// registerCompletionItemProvider) delegate to ipcCall('lsp', ...) so the
// TypeScript language server in the lsp-host utility process serves results.
// Diagnostics are pushed via ipcListen('lsp', 'diagnostics', ...) and applied
// to the Monaco model marker API.

import Editor, { useMonaco } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs-defaults";
import { fontFamily, typeScale } from "../../../../shared/design-tokens";
import { ipcCall, ipcListen } from "../../../ipc/client";
import { fileErrorMessage, parseFileErrorCode, type FileErrorCode } from "@/utils/file-error";
import { absPathToRel } from "../../../store/files/helpers";
import { useWorkspacesStore } from "../../../store/workspaces";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filePathToUri(filePath: string): string {
  return `file://${filePath}`;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

type FilePhase = "loading" | "ready" | "binary" | "error";

interface FileState {
  phase: FilePhase;
  content: string;
  errorCode?: FileErrorCode;
  encoding?: "utf8" | "utf8-bom";
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
  const disposablesRef = useRef<Monaco.IDisposable[]>([]);
  const versionRef = useRef(1);
  const uri = filePathToUri(filePath);

  const [state, setState] = useState<FileState>({ phase: "loading", content: "" });
  // Ref allows the fs.changed handler to call readFile without stale closure on state
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // -------------------------------------------------------------------------
  // Load file content
  // -------------------------------------------------------------------------

  useEffect(() => {
    setState({ phase: "loading", content: "" });

    const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!workspace) {
      setState({ phase: "error", content: "", errorCode: "OTHER" });
      return;
    }

    const relPath = absPathToRel(filePath, workspace.rootPath);

    let cancelled = false;

    ipcCall("fs", "readFile", { workspaceId, relPath })
      .then((result) => {
        if (cancelled) return;
        if (result.isBinary) {
          setState({ phase: "binary", content: "" });
        } else {
          setState({ phase: "ready", content: result.content, encoding: result.encoding });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ phase: "error", content: "", errorCode: parseFileErrorCode(message) });
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, workspaceId]);

  // -------------------------------------------------------------------------
  // Auto-reload on external changes (fs.changed events)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return;

    const relPath = absPathToRel(filePath, workspace.rootPath);

    const unlisten = ipcListen("fs", "changed", (event) => {
      if (event.workspaceId !== workspaceId) return;
      const matched = event.changes.some((c) => c.relPath === relPath);
      if (!matched) return;

      ipcCall("fs", "readFile", { workspaceId, relPath })
        .then((result) => {
          if (result.isBinary) {
            setState({ phase: "binary", content: "" });
          } else {
            setState({ phase: "ready", content: result.content, encoding: result.encoding });
            // Update the live model value without triggering a full remount
            const editor = editorRef.current;
            if (editor) {
              const model = editor.getModel();
              if (model && model.getValue() !== result.content) {
                model.setValue(result.content);
              }
            }
          }
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setState({ phase: "error", content: "", errorCode: parseFileErrorCode(message) });
        });
    });

    return unlisten;
  }, [filePath, workspaceId]);

  // -------------------------------------------------------------------------
  // LSP providers + diagnostics
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!monaco) return;

    const disposables = disposablesRef.current;

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
            return { contents: [{ value: result.contents }] };
          } catch {
            return undefined;
          }
        },
      }),
    );

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
      }),
    );

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
      }),
    );

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
          severity:
            d.severity === 1
              ? monaco.MarkerSeverity.Error
              : d.severity === 2
                ? monaco.MarkerSeverity.Warning
                : monaco.MarkerSeverity.Info,
        })),
      );
    });

    return () => {
      unlistenDiagnostics();
      for (const d of disposables) {
        d.dispose();
      }
      disposablesRef.current = [];
    };
  }, [monaco, uri]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  function handleEditorDidMount(
    editor: Monaco.editor.IStandaloneCodeEditor,
    monacoInstance: typeof Monaco,
  ): void {
    editorRef.current = editor;
    const model = monacoInstance.editor.getModel(monacoInstance.Uri.parse(uri));
    if (!model) return;
    ipcCall("lsp", "didOpen", {
      workspaceId,
      uri,
      languageId: "typescript",
      version: versionRef.current,
      text: state.content,
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

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (state.phase === "loading") {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-app-ui-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (state.phase === "binary") {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-app-ui-sm text-muted-foreground">
        Cannot display binary file.
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center text-app-ui-sm text-muted-foreground">
        {fileErrorMessage(state.errorCode ?? "OTHER", MAX_READABLE_FILE_SIZE / (1024 * 1024))}
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      path={uri}
      value={state.content}
      onMount={handleEditorDidMount}
      onChange={handleChange}
      theme="vs-dark"
      options={{
        readOnly: true,
        minimap: { enabled: false },
        fontSize: typeScale.codeBody.fontSize,
        fontFamily: fontFamily.monoBody,
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
