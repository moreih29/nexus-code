// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

import type * as Monaco from "monaco-editor";
import { ipcCall, ipcListen } from "../../ipc/client";
import { isLspLanguage } from "./language";

const COMPLETION_TRIGGER_CHARACTERS = [".", '"', "'", "`", "/", "@", "<"];
const MARKER_OWNER = "lsp";

const registeredProviderLanguages = new Set<string>();
const knownModelUris = new Set<string>();

let monacoRef: typeof Monaco | null = null;
let diagnosticsUnlisten: (() => void) | null = null;

function markerSeverity(monaco: typeof Monaco, severity: number): Monaco.MarkerSeverity {
  if (severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

function registerLanguageProviders(monaco: typeof Monaco, languageId: string): void {
  if (!isLspLanguage(languageId)) return;
  if (registeredProviderLanguages.has(languageId)) return;
  registeredProviderLanguages.add(languageId);

  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      if (!isLspLanguage(model.getLanguageId())) return null;
      try {
        const result = await ipcCall("lsp", "hover", {
          uri: model.uri.toString(),
          line: position.lineNumber - 1,
          character: position.column - 1,
        });
        if (!result || !isLspLanguage(model.getLanguageId())) return null;
        return { contents: [{ value: result.contents }] };
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position) {
      if (!isLspLanguage(model.getLanguageId())) return null;
      try {
        const results = await ipcCall("lsp", "definition", {
          uri: model.uri.toString(),
          line: position.lineNumber - 1,
          character: position.column - 1,
        });
        if (results.length === 0 || !isLspLanguage(model.getLanguageId())) return null;
        return results.map((location) => ({
          uri: monaco.Uri.parse(location.uri),
          range: {
            startLineNumber: location.line + 1,
            startColumn: location.character + 1,
            endLineNumber: location.line + 1,
            endColumn: location.character + 1,
          },
        }));
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position) {
      if (!isLspLanguage(model.getLanguageId())) return { suggestions: [] };
      try {
        const results = await ipcCall("lsp", "completion", {
          uri: model.uri.toString(),
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

        if (!isLspLanguage(model.getLanguageId())) return { suggestions: [] };
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
  });
}

function setMonaco(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;

  monacoRef = monaco;
  registeredProviderLanguages.clear();
  diagnosticsUnlisten?.();
  diagnosticsUnlisten = null;
}

function registerDiagnosticsListener(monaco: typeof Monaco): void {
  if (diagnosticsUnlisten) return;

  diagnosticsUnlisten = ipcListen("lsp", "diagnostics", (args) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(args.uri));
    if (!model) return;

    const modelUri = model.uri.toString();
    if (!knownModelUris.has(args.uri) && !knownModelUris.has(modelUri)) return;

    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      args.diagnostics.map((diagnostic) => ({
        startLineNumber: diagnostic.line + 1,
        startColumn: diagnostic.character + 1,
        endLineNumber: diagnostic.line + 1,
        endColumn: diagnostic.character + 2,
        message: diagnostic.message,
        severity: markerSeverity(monaco, diagnostic.severity),
      })),
    );
  });
}

export function initializeLspBridge(monaco: typeof Monaco): void {
  setMonaco(monaco);
  registerDiagnosticsListener(monaco);
}

export function ensureProvidersFor(languageId: string): void {
  if (!isLspLanguage(languageId)) return;
  if (!monacoRef) {
    throw new Error("LSP bridge is not initialized. Call initializeEditorServices(monaco) first.");
  }
  registerLanguageProviders(monacoRef, languageId);
}

export function registerKnownModelUri(uri: string): void {
  knownModelUris.add(uri);
}

export function unregisterKnownModelUri(uri: string): void {
  knownModelUris.delete(uri);
}

export function notifyDidOpen(
  uri: string,
  workspaceId: string,
  workspaceRoot: string,
  languageId: string,
  version: number,
  text: string,
): Promise<void> {
  return ipcCall("lsp", "didOpen", { workspaceId, workspaceRoot, uri, languageId, version, text });
}

export function notifyDidChange(uri: string, version: number, text: string): Promise<void> {
  return ipcCall("lsp", "didChange", { uri, version, text });
}

export function notifyDidClose(uri: string): Promise<void> {
  return ipcCall("lsp", "didClose", { uri });
}
