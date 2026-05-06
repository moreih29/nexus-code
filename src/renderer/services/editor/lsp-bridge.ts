// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

import type * as Monaco from "monaco-editor";
import type {
  ApplyWorkspaceEditParams,
  ApplyWorkspaceEditResult,
  Diagnostic,
  DiagnosticRelatedInformation,
  MarkupContentOrString,
  Range,
  TextEdit,
  TextDocumentContentChangeEvent,
  WorkspaceDocumentChange,
} from "../../../shared/lsp-types";
import { ipcCall, ipcListen } from "../../ipc/client";
import { isLspLanguage } from "./language";

const COMPLETION_TRIGGER_CHARACTERS = [".", '"', "'", "`", "/", "@", "<"];
const MARKER_OWNER = "lsp";
const MARKDOWN_PLAINTEXT_ESCAPE_PATTERN = /([\\`*_{}[\]()#+\-.!|>])/g;
const LSP_DIAGNOSTIC_TAG_UNNECESSARY = 1;
const LSP_DIAGNOSTIC_TAG_DEPRECATED = 2;

const registeredProviderLanguages = new Set<string>();
const knownModelUris = new Set<string>();

let monacoRef: typeof Monaco | null = null;
let diagnosticsUnlisten: (() => void) | null = null;
let applyEditUnlisten: (() => void) | null = null;

function markerSeverity(
  monaco: typeof Monaco,
  severity: number | undefined,
): Monaco.MarkerSeverity {
  if (severity === undefined || severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 4) return monaco.MarkerSeverity.Hint;
  return monaco.MarkerSeverity.Info;
}

function lspRangeToMonacoRange(range: Range): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function lspTextEditToMonacoEdit(edit: TextEdit): Monaco.editor.IIdentifiedSingleEditOperation {
  return {
    range: lspRangeToMonacoRange(edit.range),
    text: edit.newText,
    forceMoveMarkers: true,
  };
}

function isTextDocumentEdit(
  change: WorkspaceDocumentChange,
): change is Extract<WorkspaceDocumentChange, { textDocument: unknown }> {
  return "textDocument" in change;
}

type ModelEditBatch = {
  model: Monaco.editor.ITextModel;
  edits: TextEdit[];
};

function modelForUri(monaco: typeof Monaco, uri: string): Monaco.editor.ITextModel | null {
  return monaco.editor.getModel(monaco.Uri.parse(uri));
}

function collectDocumentChanges(
  monaco: typeof Monaco,
  documentChanges: WorkspaceDocumentChange[],
): ModelEditBatch[] | null {
  const batches = new Map<string, ModelEditBatch>();

  for (const change of documentChanges) {
    if (!isTextDocumentEdit(change)) return null;

    const { uri, version } = change.textDocument;
    const model = modelForUri(monaco, uri);
    if (!model) return null;
    if (version !== null && model.getVersionId() !== version) return null;

    const existing = batches.get(uri);
    if (existing) {
      existing.edits.push(...change.edits);
    } else {
      batches.set(uri, { model, edits: [...change.edits] });
    }
  }

  return [...batches.values()];
}

function collectChangesMap(
  monaco: typeof Monaco,
  changes: Record<string, TextEdit[]>,
): ModelEditBatch[] | null {
  const batches: ModelEditBatch[] = [];

  for (const [uri, edits] of Object.entries(changes)) {
    const model = modelForUri(monaco, uri);
    if (!model) return null;
    batches.push({ model, edits });
  }

  return batches;
}

function applyEditBatches(batches: ModelEditBatch[]): void {
  for (const batch of batches) {
    batch.model.applyEdits(batch.edits.map((edit) => lspTextEditToMonacoEdit(edit)));
  }
}

export function applyWorkspaceEdit(
  monaco: typeof Monaco,
  params: ApplyWorkspaceEditParams,
): ApplyWorkspaceEditResult {
  const { edit } = params;
  const batches =
    edit.documentChanges !== undefined
      ? collectDocumentChanges(monaco, edit.documentChanges)
      : collectChangesMap(monaco, edit.changes ?? {});

  if (!batches) return { applied: false };

  applyEditBatches(batches);
  return { applied: true };
}

export function monacoContentChangeToLsp(
  change: Monaco.editor.IModelContentChange,
): TextDocumentContentChangeEvent {
  return {
    range: {
      start: {
        line: change.range.startLineNumber - 1,
        character: change.range.startColumn - 1,
      },
      end: {
        line: change.range.endLineNumber - 1,
        character: change.range.endColumn - 1,
      },
    },
    rangeLength: change.rangeLength,
    text: change.text,
  };
}

export function monacoContentChangesToLsp(
  changes: readonly Monaco.editor.IModelContentChange[],
): TextDocumentContentChangeEvent[] {
  return changes.map((change) => monacoContentChangeToLsp(change));
}

function escapeMarkdownPlaintext(value: string): string {
  return value.replace(MARKDOWN_PLAINTEXT_ESCAPE_PATTERN, "\\$1");
}

function hoverContentsToMarkdown(contents: MarkupContentOrString): Monaco.IMarkdownString {
  if (typeof contents === "string") {
    return { value: contents };
  }
  if (contents.kind === "markdown") {
    return { value: contents.value };
  }
  return { value: escapeMarkdownPlaintext(contents.value) };
}

function diagnosticTags(
  monaco: typeof Monaco,
  tags: Diagnostic["tags"],
): Monaco.MarkerTag[] | undefined {
  if (!tags) return undefined;
  const markerTags = tags.flatMap((tag) => {
    if (tag === LSP_DIAGNOSTIC_TAG_UNNECESSARY) return [monaco.MarkerTag.Unnecessary];
    if (tag === LSP_DIAGNOSTIC_TAG_DEPRECATED) return [monaco.MarkerTag.Deprecated];
    return [];
  });
  return markerTags.length > 0 ? markerTags : undefined;
}

function diagnosticCode(
  monaco: typeof Monaco,
  diagnostic: Diagnostic,
): Monaco.editor.IMarkerData["code"] {
  if (diagnostic.code === undefined) return undefined;
  const value = String(diagnostic.code);
  if (!diagnostic.codeDescription?.href) return value;
  return {
    value,
    target: monaco.Uri.parse(diagnostic.codeDescription.href),
  };
}

function relatedInformation(
  monaco: typeof Monaco,
  items: DiagnosticRelatedInformation[] | undefined,
): Monaco.editor.IRelatedInformation[] | undefined {
  if (!items) return undefined;
  return items.map((item) => ({
    resource: monaco.Uri.parse(item.location.uri),
    message: item.message,
    ...lspRangeToMonacoRange(item.location.range),
  }));
}

export function lspDiagnosticToMonacoMarker(
  monaco: typeof Monaco,
  diagnostic: Diagnostic,
): Monaco.editor.IMarkerData {
  return {
    ...lspRangeToMonacoRange(diagnostic.range),
    message: diagnostic.message,
    severity: markerSeverity(monaco, diagnostic.severity),
    code: diagnosticCode(monaco, diagnostic),
    source: diagnostic.source,
    tags: diagnosticTags(monaco, diagnostic.tags),
    relatedInformation: relatedInformation(monaco, diagnostic.relatedInformation),
  };
}

export function tokenToAbortSignal(token: Monaco.CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
    return controller.signal;
  }

  let disposable: { dispose(): void } | null = null;
  disposable = token.onCancellationRequested(() => {
    controller.abort();
    disposable?.dispose();
  });
  return controller.signal;
}

function registerLanguageProviders(monaco: typeof Monaco, languageId: string): void {
  if (!isLspLanguage(languageId)) return;
  if (registeredProviderLanguages.has(languageId)) return;
  registeredProviderLanguages.add(languageId);

  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position, token) {
      if (!isLspLanguage(model.getLanguageId())) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const result = await ipcCall(
          "lsp",
          "hover",
          {
            uri: model.uri.toString(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          { signal },
        );
        if (!result || !isLspLanguage(model.getLanguageId())) return null;
        return {
          contents: [hoverContentsToMarkdown(result.contents)],
          range: result.range ? lspRangeToMonacoRange(result.range) : undefined,
        };
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position, token) {
      if (!isLspLanguage(model.getLanguageId())) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const results = await ipcCall(
          "lsp",
          "definition",
          {
            uri: model.uri.toString(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          { signal },
        );
        if (results.length === 0 || !isLspLanguage(model.getLanguageId())) return null;
        return results.map((location) => ({
          uri: monaco.Uri.parse(location.uri),
          range: lspRangeToMonacoRange(location.range),
        }));
      } catch {
        return null;
      }
    },
  });

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, _context, token) {
      if (!isLspLanguage(model.getLanguageId())) return { suggestions: [] };
      try {
        const signal = tokenToAbortSignal(token);
        const results = await ipcCall(
          "lsp",
          "completion",
          {
            uri: model.uri.toString(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          { signal },
        );
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
  applyEditUnlisten?.();
  applyEditUnlisten = null;
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
      args.diagnostics.map((diagnostic) => lspDiagnosticToMonacoMarker(monaco, diagnostic)),
    );
  });
}

function registerApplyEditListener(monaco: typeof Monaco): void {
  if (applyEditUnlisten) return;

  applyEditUnlisten = ipcListen("lsp", "applyEdit", (args) => {
    const result = (() => {
      try {
        return applyWorkspaceEdit(monaco, args.params);
      } catch (error) {
        return { applied: false, failureReason: String(error) };
      }
    })();

    ipcCall("lsp", "applyEditResult", { requestId: args.requestId, result }).catch(() => {});
  });
}

export function initializeLspBridge(monaco: typeof Monaco): void {
  setMonaco(monaco);
  registerDiagnosticsListener(monaco);
  registerApplyEditListener(monaco);
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

export function notifyDidChange(
  uri: string,
  version: number,
  contentChanges: TextDocumentContentChangeEvent[],
): Promise<void> {
  return ipcCall("lsp", "didChange", { uri, version, contentChanges });
}

export function notifyDidSave(uri: string, text?: string): Promise<void> {
  return ipcCall("lsp", "didSave", { uri, text });
}

export function notifyDidClose(uri: string): Promise<void> {
  return ipcCall("lsp", "didClose", { uri });
}
