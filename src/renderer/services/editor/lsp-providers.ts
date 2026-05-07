// Monaco language provider registrations for LSP features.
// No module-level state — all state (registeredProviderLanguages) is managed by the caller.

import type * as Monaco from "monaco-editor";
import { ipcCall } from "../../ipc/client";
import { isLspLanguage } from "./language";
import {
  hoverContentsToMarkdown,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspRangeToMonacoRange,
  tokenToAbortSignal,
} from "./lsp-monaco-converters";
import { preAcquireLocationModels } from "./lsp-result-preacquire";

const COMPLETION_TRIGGER_CHARACTERS = [".", '"', "'", "`", "/", "@", "<"];

export function registerLanguageProviders(
  monaco: typeof Monaco,
  languageId: string,
  registeredLanguages: Set<string>,
  fetchDocumentSymbols: (
    uri: string,
    signal?: AbortSignal,
  ) => Promise<import("../../../shared/lsp-types").DocumentSymbol[]>,
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
        await preAcquireLocationModels(monacoLocations, model.uri.toString());
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
        await preAcquireLocationModels(monacoLocations, model.uri.toString());
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
}
