// Pure, stateless converters between LSP types and Monaco types.
// No module-level state — all functions accept monaco as a parameter.

import type * as Monaco from "monaco-editor";
import type {
  Diagnostic,
  DiagnosticRelatedInformation,
  DocumentHighlight,
  DocumentSymbol,
  Location,
  MarkupContentOrString,
  Range,
  SymbolInformation,
  TextDocumentContentChangeEvent,
} from "../../../shared/lsp-types";

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

export function lspLocationToMonacoLocation(
  monaco: typeof Monaco,
  location: Location,
): Monaco.languages.Location {
  return {
    uri: monaco.Uri.parse(location.uri),
    range: lspRangeToMonacoRange(location.range),
  };
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
): WorkspaceSymbolResult {
  return {
    name: symbol.name,
    kind: lspSymbolKindToMonacoKind(symbol.kind),
    tags: symbol.tags as Monaco.languages.SymbolTag[] | undefined,
    containerName: symbol.containerName,
    location: lspLocationToMonacoLocation(monaco, symbol.location),
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

export function markerSeverity(
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
