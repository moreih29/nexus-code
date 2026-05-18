// Monaco language provider registrations for LSP features.
// No module-level state — all state (registeredProviderLanguages) is managed by the caller.

import type * as Monaco from "monaco-editor";
import { ipcCall } from "../../../ipc/client";
import { isLspLanguage } from "./language";
import {
  hoverContentsToMarkdown,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspRangeToMonacoRange,
  tokenToAbortSignal,
} from "./monaco-converters";

const COMPLETION_TRIGGER_CHARACTERS = [".", '"', "'", "`", "/", "@", "<"];

// ---------------------------------------------------------------------------
// Semantic tokens legend
//
// The token types listed here mirror the standard LSP 3.16 legend advertised
// in client-capabilities.ts. Each string maps to a Monaco token type name
// used in the semantic rules registered by buildSemanticRules() in
// monaco-theme.ts. Unknown / unmapped types produce an empty string and are
// silently ignored by Monaco.
//
// Legend → palette mapping (design.md §15.1, frozen 15-role set):
//   function / method               → "function"   (syntaxFunction)
//   class / interface / struct      → "type"        (syntaxType)
//   enum / type / typeParameter     → "type"        (syntaxType)
//   variable / parameter            → "variable"    (syntaxVariable)
//   property / enumMember           → "property"    (syntaxProperty)
//   keyword / modifier              → "keyword"     (syntaxKeyword)
//   namespace                       → "namespace"   (syntaxNamespace)
//   string                          → "string"      (syntaxString)
//   number                          → "number"      (syntaxNumber)
//   comment                         → "comment"     (syntaxComment)
//   operator                        → "operator"    (syntaxOperator)
//
// Folded (no matching role → nearest existing):
//   macro     → "function"  (closest callable concept)
//   event     → "variable"  (runtime value, no better role)
//   decorator → "keyword"   (meta/annotation intent)
//   label     → "variable"  (identifier-like, no better role)
//   regexp    → "string"    (string-like literal)
// ---------------------------------------------------------------------------
const SEMANTIC_TOKEN_TYPES: string[] = [
  "namespace", // 0
  "type", // 1  class
  "type", // 2  class
  "type", // 3  enum
  "type", // 4  interface
  "type", // 5  struct
  "type", // 6  typeParameter
  "variable", // 7  parameter
  "variable", // 8  variable
  "property", // 9  property
  "property", // 10 enumMember
  "variable", // 11 event       → folded to variable
  "function", // 12 function
  "function", // 13 method
  "function", // 14 macro       → folded to function
  "keyword", // 15 keyword
  "keyword", // 16 modifier     → folded to keyword
  "comment", // 17 comment
  "string", // 18 string
  "number", // 19 number
  "string", // 20 regexp        → folded to string
  "operator", // 21 operator
  "keyword", // 22 decorator    → folded to keyword
  "variable", // 23 label       → folded to variable
];

// Monaco's SemanticTokensLegend: the tokenTypes list must match the indices
// the server uses when encoding the data array.
const SEMANTIC_TOKENS_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: SEMANTIC_TOKEN_TYPES,
  tokenModifiers: [],
};

/** Curried pre-acquire closure: takes locations + source URI, returns Promise. */
export type PreAcquireFn = (
  locations: readonly Monaco.languages.Location[],
  sourceUri: string,
) => Promise<void>;

export function registerLanguageProviders(
  monaco: typeof Monaco,
  languageId: string,
  registeredLanguages: Set<string>,
  fetchDocumentSymbols: (
    uri: string,
    signal?: AbortSignal,
  ) => Promise<import("../../../../shared/lsp").DocumentSymbol[]>,
  preAcquire: PreAcquireFn,
): void {
  if (!isLspLanguage(languageId)) return;
  if (registeredLanguages.has(languageId)) return;
  registeredLanguages.add(languageId);

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
        const monacoLocations = results.map((location) =>
          lspLocationToMonacoLocation(monaco, location),
        );
        // Pre-acquire result models so monaco's peek widget can resolve
        // them via createModelReference without throwing "Model not found".
        await preAcquire(monacoLocations, model.uri.toString());
        return monacoLocations;
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

  monaco.languages.registerReferenceProvider(languageId, {
    async provideReferences(model, position, context, token) {
      if (!isLspLanguage(model.getLanguageId())) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = await ipcCall(
          "lsp",
          "references",
          {
            uri: model.uri.toString(),
            line: position.lineNumber - 1,
            character: position.column - 1,
            includeDeclaration: context.includeDeclaration,
          },
          { signal },
        );
        if (!isLspLanguage(model.getLanguageId())) return [];
        const monacoLocations = results.map((location) =>
          lspLocationToMonacoLocation(monaco, location),
        );
        // Pre-acquire — same rationale as provideDefinition. Find-references
        // peek can include many locations; we still pre-acquire all of them
        // since peek expands on user click and any unresolved URI would
        // throw at that moment.
        await preAcquire(monacoLocations, model.uri.toString());
        return monacoLocations;
      } catch {
        return [];
      }
    },
  });

  monaco.languages.registerDocumentHighlightProvider(languageId, {
    async provideDocumentHighlights(model, position, token) {
      if (!isLspLanguage(model.getLanguageId())) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = await ipcCall(
          "lsp",
          "documentHighlight",
          {
            uri: model.uri.toString(),
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          { signal },
        );
        if (!isLspLanguage(model.getLanguageId())) return [];
        return results.map((highlight) => lspDocumentHighlightToMonacoHighlight(highlight));
      } catch {
        return [];
      }
    },
  });

  monaco.languages.registerDocumentSymbolProvider(languageId, {
    async provideDocumentSymbols(model, token) {
      if (!isLspLanguage(model.getLanguageId())) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = await fetchDocumentSymbols(model.uri.toString(), signal);
        if (!isLspLanguage(model.getLanguageId())) return [];
        return results.map((symbol) => lspDocumentSymbolToMonacoSymbol(symbol));
      } catch {
        return [];
      }
    },
  });

  monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
    getLegend(): Monaco.languages.SemanticTokensLegend {
      return SEMANTIC_TOKENS_LEGEND;
    },

    async provideDocumentSemanticTokens(
      model,
      _lastResultId,
      token,
    ): Promise<Monaco.languages.SemanticTokens | null> {
      if (!isLspLanguage(model.getLanguageId())) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const result = await ipcCall(
          "lsp",
          "semanticTokens",
          { uri: model.uri.toString() },
          { signal },
        );
        if (!result || !isLspLanguage(model.getLanguageId())) return null;
        return { data: new Uint32Array(result.data), resultId: result.resultId };
      } catch {
        return null;
      }
    },

    releaseDocumentSemanticTokens(_resultId): void {
      // Nothing to release for full-document mode.
    },
  });
}
