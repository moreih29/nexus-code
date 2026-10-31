// Pure, stateless converters between LSP types and Monaco types.
// No module-level state — all functions accept monaco as a parameter.

import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import {
  type CompletionItem,
  CompletionItemTagDeprecated,
  type Diagnostic,
  type DiagnosticRelatedInformation,
  type DocumentHighlight,
  type DocumentSymbol,
  InsertTextFormatSnippet,
  type Location,
  type MarkupContentOrString,
  type Range,
  type SymbolInformation,
  type TextDocumentContentChangeEvent,
} from "../../../../shared/lsp";

const MARKDOWN_PLAINTEXT_ESCAPE_PATTERN = /([\\`*_{}[\]()#+\-.!|>])/g;
const LSP_DIAGNOSTIC_TAG_UNNECESSARY = 1;
const LSP_DIAGNOSTIC_TAG_DEPRECATED = 2;
const LSP_SYMBOL_KIND_OFFSET = 1;
const LSP_DOCUMENT_HIGHLIGHT_KIND_OFFSET = 1;

export function lspRangeToMonacoRange(range: Range): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/**
 * Convert an LSP Location (always `file://` from the server) into a Monaco
 * Location whose URI is the workspace-scoped cacheUri (`nexus-ws://…`).
 * The cacheUri is what Monaco model identity uses, so passing through
 * `file://` here would point at no model and the peek widget would
 * throw "Model not found" on click.
 *
 * `workspaceId` is the workspace from which the LSP request originated.
 * Cross-file navigation results inherit that workspace context — clicking
 * a definition that lives outside the workspace tree still opens a model
 * scoped to the requesting workspace, which matches how the user is
 * navigating from within that workspace.
 *
 * Non-file URIs (e.g. tsserver's volar virtual schemes) pass through
 * untranslated so Monaco can fall back to its own handlers.
 */
export function lspLocationToMonacoLocation(
  monaco: typeof Monaco,
  location: Location,
  workspaceId: string,
): Monaco.languages.Location {
  const absPath = fileUriToAbsolutePath(location.uri);
  const uri = absPath !== null ? workspaceUriFor(workspaceId, absPath) : location.uri;
  return {
    uri: monaco.Uri.parse(uri),
    range: lspRangeToMonacoRange(location.range),
  };
}

// LSP numbers completion item kinds from 1 in an order of its own; Monaco's
// enum lists the same kinds in another order, so they map by name.
const LSP_COMPLETION_ITEM_KINDS = [
  "Text",
  "Method",
  "Function",
  "Constructor",
  "Field",
  "Variable",
  "Class",
  "Interface",
  "Module",
  "Property",
  "Unit",
  "Value",
  "Enum",
  "Keyword",
  "Snippet",
  "Color",
  "File",
  "Reference",
  "Folder",
  "EnumMember",
  "Constant",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
] as const satisfies readonly (keyof typeof Monaco.languages.CompletionItemKind)[];

export function lspCompletionItemKindToMonacoKind(
  monaco: typeof Monaco,
  kind: number | undefined,
): Monaco.languages.CompletionItemKind {
  const name = kind === undefined ? undefined : LSP_COMPLETION_ITEM_KINDS[kind - 1];
  return monaco.languages.CompletionItemKind[name ?? "Text"];
}

// Editor commands a server may attach to a completion item; others are the
// server's own and have no handler here.
const COMPLETION_ITEM_EDITOR_COMMANDS = new Set([
  "editor.action.triggerSuggest",
  "editor.action.triggerParameterHints",
]);

/**
 * An LSP completion item as Monaco takes it. The item replaces
 * `defaultRange`, the word before the cursor, unless it names a range of its
 * own that Monaco can use: one line, around the cursor.
 */
export function lspCompletionItemToMonaco(
  monaco: typeof Monaco,
  item: CompletionItem,
  position: Monaco.IPosition,
  defaultRange: Monaco.IRange,
): Monaco.languages.CompletionItem {
  const deprecated = item.deprecated === true || item.tags?.includes(CompletionItemTagDeprecated);
  return {
    label: item.labelDetails
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label,
    kind: lspCompletionItemKindToMonacoKind(monaco, item.kind),
    tags: deprecated ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    ...lspCompletionItemDetails(item),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === InsertTextFormatSnippet
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    range: completionItemRange(item, position) ?? defaultRange,
    commitCharacters: item.commitCharacters,
    command:
      item.command && COMPLETION_ITEM_EDITOR_COMMANDS.has(item.command.command)
        ? { id: item.command.command, title: item.command.title }
        : undefined,
  };
}

/** What `completionItem/resolve` may fill in, as Monaco takes it. */
export function lspCompletionItemDetails(
  item: CompletionItem,
): Pick<Monaco.languages.CompletionItem, "detail" | "documentation" | "additionalTextEdits"> {
  return {
    detail: item.detail,
    documentation:
      item.documentation === undefined ? undefined : lspDocumentationToMonaco(item.documentation),
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
      range: lspRangeToMonacoRange(edit.range),
      text: edit.newText,
    })),
  };
}

function completionItemRange(
  item: CompletionItem,
  position: Monaco.IPosition,
): Monaco.languages.CompletionItem["range"] | undefined {
  const edit = item.textEdit;
  if (!edit) return undefined;
  if ("range" in edit) {
    const range = lspRangeToMonacoRange(edit.range);
    return rangeAroundPosition(range, position) ? range : undefined;
  }
  const insert = lspRangeToMonacoRange(edit.insert);
  const replace = lspRangeToMonacoRange(edit.replace);
  return rangeAroundPosition(insert, position) && rangeAroundPosition(replace, position)
    ? { insert, replace }
    : undefined;
}

function rangeAroundPosition(range: Monaco.IRange, position: Monaco.IPosition): boolean {
  return (
    range.startLineNumber === position.lineNumber &&
    range.endLineNumber === position.lineNumber &&
    range.startColumn <= position.column &&
    range.endColumn >= position.column
  );
}

function lspDocumentationToMonaco(doc: MarkupContentOrString): string | Monaco.IMarkdownString {
  if (typeof doc === "string") return doc;
  return doc.kind === "markdown" ? { value: doc.value } : doc.value;
}

function lspSymbolKindToMonacoKind(kind: number): Monaco.languages.SymbolKind {
  return (kind - LSP_SYMBOL_KIND_OFFSET) as Monaco.languages.SymbolKind;
}

function lspDocumentHighlightKindToMonacoKind(
  kind: DocumentHighlight["kind"],
): Monaco.languages.DocumentHighlightKind | undefined {
  if (kind === undefined) return undefined;
  return (kind - LSP_DOCUMENT_HIGHLIGHT_KIND_OFFSET) as Monaco.languages.DocumentHighlightKind;
}

export function lspDocumentHighlightToMonacoHighlight(
  highlight: DocumentHighlight,
): Monaco.languages.DocumentHighlight {
  return {
    range: lspRangeToMonacoRange(highlight.range),
    kind: lspDocumentHighlightKindToMonacoKind(highlight.kind),
  };
}

export function lspDocumentSymbolToMonacoSymbol(
  symbol: DocumentSymbol,
): Monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: lspSymbolKindToMonacoKind(symbol.kind),
    tags: (symbol.tags ?? []) as Monaco.languages.SymbolTag[],
    range: lspRangeToMonacoRange(symbol.range),
    selectionRange: lspRangeToMonacoRange(symbol.selectionRange),
    children: symbol.children?.map((child) => lspDocumentSymbolToMonacoSymbol(child)),
  };
}

export type WorkspaceSymbolResult = {
  name: string;
  kind: Monaco.languages.SymbolKind;
  tags?: readonly Monaco.languages.SymbolTag[];
  containerName?: string;
  location: Monaco.languages.Location;
};

export function lspSymbolInformationToWorkspaceSymbol(
  monaco: typeof Monaco,
  symbol: SymbolInformation,
  workspaceId: string,
): WorkspaceSymbolResult {
  return {
    name: symbol.name,
    kind: lspSymbolKindToMonacoKind(symbol.kind),
    tags: symbol.tags as Monaco.languages.SymbolTag[] | undefined,
    containerName: symbol.containerName,
    location: lspLocationToMonacoLocation(monaco, symbol.location, workspaceId),
  };
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

export function hoverContentsToMarkdown(contents: MarkupContentOrString): Monaco.IMarkdownString {
  if (typeof contents === "string") {
    return { value: contents };
  }
  if (contents.kind === "markdown") {
    return { value: contents.value };
  }
  return { value: contents.value.replace(MARKDOWN_PLAINTEXT_ESCAPE_PATTERN, "\\$1") };
}

function markerSeverity(
  monaco: typeof Monaco,
  severity: number | undefined,
): Monaco.MarkerSeverity {
  if (severity === undefined || severity === 1) return monaco.MarkerSeverity.Error;
  if (severity === 2) return monaco.MarkerSeverity.Warning;
  if (severity === 4) return monaco.MarkerSeverity.Hint;
  return monaco.MarkerSeverity.Info;
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
