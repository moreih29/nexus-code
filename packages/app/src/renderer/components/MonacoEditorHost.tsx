import { useEffect, useRef } from "react";

import type {
  LspDiagnostic,
  LspLanguage,
  LspWorkspaceEdit,
  LspWorkspaceEditApplicationResult,
} from "../../../../shared/src/contracts/editor/editor-bridge";
import type { WorkspaceId } from "../../../../shared/src/contracts/workspace/workspace";
import { mapLspDiagnosticsToMonacoMarkers } from "../editor/monaco-lsp-markers";
import { registerLspCodeActionProvider } from "../editor/monaco-providers/code-action-provider";
import { registerLspCompletionProvider } from "../editor/monaco-providers/completion-provider";
import { registerLspDefinitionProvider } from "../editor/monaco-providers/definition-provider";
import { registerLspDocumentSymbolsProvider } from "../editor/monaco-providers/document-symbols-provider";
import { registerLspFormattingProviders } from "../editor/monaco-providers/formatting-provider";
import { registerLspHoverProvider } from "../editor/monaco-providers/hover-provider";
import { registerLspReferencesProvider } from "../editor/monaco-providers/references-provider";
import { createNexusMonacoModelUri } from "../editor/monaco-providers/read-provider-mapping";
import { registerLspRenameProvider } from "../editor/monaco-providers/rename-provider";
import { registerLspSignatureHelpProvider } from "../editor/monaco-providers/signature-help-provider";

export interface MonacoEditorHostProps {
  workspaceId: string;
  path: string;
  languageId: string;
  lspLanguage: LspLanguage | null;
  value: string;
  diagnostics: LspDiagnostic[];
  onChange(value: string): void;
  onApplyWorkspaceEdit?(
    workspaceId: WorkspaceId,
    edit: LspWorkspaceEdit,
  ): Promise<LspWorkspaceEditApplicationResult>;
}

type MonacoApi = typeof import("monaco-editor");
type MonacoEditor = import("monaco-editor").editor.IStandaloneCodeEditor;
type MonacoModel = import("monaco-editor").editor.ITextModel;
type MonacoDisposable = import("monaco-editor").IDisposable;
type MonacoUri = import("monaco-editor").Uri;

const MARKER_OWNER = "nexus-lsp";
const sharedModels = new Map<string, { model: MonacoModel; references: number }>();

export function MonacoEditorHost({
  workspaceId,
  path,
  languageId,
  lspLanguage,
  value,
  diagnostics,
  onChange,
  onApplyWorkspaceEdit,
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
    let lspProviderDisposables: MonacoDisposable[] = [];

    void import("monaco-editor").then((monaco) => {
      if (disposed) {
        return;
      }

      monacoRef.current = monaco;
      defineNexusTheme(monaco);
      const model = acquireMonacoModel(monaco, workspaceId, path, languageId, valueRef.current);
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
      lspProviderDisposables = lspLanguage
        ? [
            registerLspCompletionProvider(monaco, {
              workspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspHoverProvider(monaco, {
              workspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspDefinitionProvider(monaco, {
              workspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspReferencesProvider(monaco, {
              workspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspDocumentSymbolsProvider(monaco, {
              workspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspRenameProvider(monaco, {
              workspaceId: workspaceId as WorkspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
              applyWorkspaceEdit: onApplyWorkspaceEdit ?? noopApplyWorkspaceEdit,
            }),
            registerLspFormattingProviders(monaco, {
              workspaceId: workspaceId as WorkspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspSignatureHelpProvider(monaco, {
              workspaceId: workspaceId as WorkspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
            }),
            registerLspCodeActionProvider(monaco, {
              workspaceId: workspaceId as WorkspaceId,
              path,
              language: lspLanguage,
              languageId,
              model,
              editorApi: window.nexusEditor,
              applyWorkspaceEdit: onApplyWorkspaceEdit ?? noopApplyWorkspaceEdit,
            }),
          ]
        : [];

      installFindReplaceKeybindings(monaco, editor);
      monaco.editor.setModelLanguage(model, languageId);
      applyMarkers(monaco, model, diagnosticsRef.current);
      editorRef.current = editor;
      modelRef.current = model;
    });

    return () => {
      disposed = true;
      contentDisposable?.dispose();
      for (const lspProviderDisposable of lspProviderDisposables) {
        lspProviderDisposable.dispose();
      }
      editorRef.current?.dispose();
      if (monacoRef.current && modelRef.current) {
        releaseMonacoModel(monacoRef.current, modelRef.current);
      }
      editorRef.current = null;
      modelRef.current = null;
    };
  }, [languageId, lspLanguage, onApplyWorkspaceEdit, path, workspaceId]);

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

function acquireMonacoModel(
  monaco: MonacoApi,
  workspaceId: string,
  filePath: string,
  languageId: string,
  value: string,
): MonacoModel {
  const uri = createMonacoUri(monaco, workspaceId, filePath);
  const key = uri.toString();
  const existing = sharedModels.get(key);
  if (existing) {
    existing.references += 1;
    monaco.editor.setModelLanguage(existing.model, languageId);
    if (existing.model.getValue() !== value) {
      existing.model.setValue(value);
    }
    return existing.model;
  }

  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(value, languageId, uri);
  monaco.editor.setModelLanguage(model, languageId);
  if (model.getValue() !== value) {
    model.setValue(value);
  }
  sharedModels.set(key, { model, references: 1 });
  return model;
}

function releaseMonacoModel(monaco: MonacoApi, model: MonacoModel): void {
  const key = model.uri.toString();
  const existing = sharedModels.get(key);
  if (!existing) {
    return;
  }

  if (existing.references > 1) {
    sharedModels.set(key, {
      model: existing.model,
      references: existing.references - 1,
    });
    return;
  }

  sharedModels.delete(key);
  monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  model.dispose();
}

function applyMarkers(
  monaco: MonacoApi | null,
  model: MonacoModel | null,
  diagnostics: readonly LspDiagnostic[],
): void {
  if (!monaco || !model) {
    return;
  }

  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    mapLspDiagnosticsToMonacoMarkers(diagnostics, monaco.MarkerSeverity),
  );
}

function noopApplyWorkspaceEdit(): Promise<LspWorkspaceEditApplicationResult> {
  return Promise.resolve({
    applied: false,
    appliedPaths: [],
    skippedClosedPaths: [],
    skippedUnsupportedPaths: [],
  });
}

function createMonacoUri(monaco: MonacoApi, workspaceId: string, filePath: string): MonacoUri {
  return createNexusMonacoModelUri(monaco, workspaceId, filePath);
}
