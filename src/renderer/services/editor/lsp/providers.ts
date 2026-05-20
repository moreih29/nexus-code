// Monaco language provider registrations for LSP features.
// No module-level state — all state (registeredProviderLanguages) is managed by the caller.

import type * as Monaco from "monaco-editor";
import { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import { parseWorkspaceUri } from "../../../../shared/fs/workspace-uri";
import { CANONICAL_TOKEN_TYPES } from "../../../../shared/lsp/semantic-tokens";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
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

/**
 * Recover (workspaceId, lspUri) from a Monaco model whose URI is a
 * workspace-scoped cacheUri (`nexus-ws://${workspaceId}${absPath}`).
 * Returns null when the model URI is not workspace-scoped — providers
 * skip the LSP call in that case (Monaco's built-in providers may still
 * fire, but our IPC routing requires the workspace context to exist).
 */
function modelLspContext(model: Monaco.editor.ITextModel): { workspaceId: string; lspUri: string } | null {
  const parsed = parseWorkspaceUri(model.uri.toString());
  if (!parsed) return null;
  return {
    workspaceId: parsed.workspaceId,
    lspUri: absolutePathToFileUri(parsed.absolutePath),
  };
}

// ---------------------------------------------------------------------------
// Semantic tokens legend
//
// CANONICAL_TOKEN_TYPES (imported from shared/lsp/semantic-tokens.ts) is the
// single source of truth for the token-type list. It holds the standard LSP
// 3.16 token-type names in canonical order. The agent remaps every server
// response to this order before it reaches the renderer, so getLegend() can
// return these names directly and Monaco's theme rules just need to match
// by name. See shared/lsp/semantic-tokens.ts for the full legend→palette
// mapping documentation.
// ---------------------------------------------------------------------------

// Monaco's SemanticTokensLegend: the tokenTypes list contains the canonical
// LSP token-type names. Monaco matches these names against the theme rules
// in buildSyntaxRules (monaco-theme.ts) to determine foreground colours.
const SEMANTIC_TOKENS_LEGEND: Monaco.languages.SemanticTokensLegend = {
  tokenTypes: CANONICAL_TOKEN_TYPES as string[],
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
    workspaceId: string,
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
      const ctx = modelLspContext(model);
      if (!ctx) {
        console.log("[hover] no ctx — model.uri:", model.uri.toString(), "lang:", model.getLanguageId());
        return null;
      }
      const traceTag = `[hover ${ctx.workspaceId.slice(0, 8)} ${ctx.lspUri.split("/").pop()}]`;
      console.log(traceTag, "start", position.lineNumber, position.column);
      try {
        const signal = tokenToAbortSignal(token);
        const ipcResult = await ipcCallResult(
          "lsp",
          "hover",
          {
            workspaceId: ctx.workspaceId,
            uri: ctx.lspUri,
            line: position.lineNumber - 1,
            character: position.column - 1,
          },
          { signal },
        );
        console.log(traceTag, "ipc returned");
        const result = unwrapIpcResult(ipcResult);
        console.log(traceTag, "unwrapped", result === null ? "null" : "has-data");
        if (!result || !isLspLanguage(model.getLanguageId())) return null;
        return {
          contents: [hoverContentsToMarkdown(result.contents)],
          range: result.range ? lspRangeToMonacoRange(result.range) : undefined,
        };
      } catch (err) {
        console.log(traceTag, "threw", err);
        return null;
      }
    },
  });

  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position, token) {
      if (!isLspLanguage(model.getLanguageId())) return null;
      const ctx = modelLspContext(model);
      if (!ctx) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const results = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "definition",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            { signal },
          ),
        );
        if (results.length === 0 || !isLspLanguage(model.getLanguageId())) return null;
        const monacoLocations = results.map((location) =>
          lspLocationToMonacoLocation(monaco, location, ctx.workspaceId),
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
      const ctx = modelLspContext(model);
      if (!ctx) return { suggestions: [] };
      try {
        const signal = tokenToAbortSignal(token);
        const results = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "completion",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            { signal },
          ),
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
      const ctx = modelLspContext(model);
      if (!ctx) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "references",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
              includeDeclaration: context.includeDeclaration,
            },
            { signal },
          ),
        );
        if (!isLspLanguage(model.getLanguageId())) return [];
        const monacoLocations = results.map((location) =>
          lspLocationToMonacoLocation(monaco, location, ctx.workspaceId),
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
      const ctx = modelLspContext(model);
      if (!ctx) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "documentHighlight",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            { signal },
          ),
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
      const ctx = modelLspContext(model);
      if (!ctx) return [];
      try {
        const signal = tokenToAbortSignal(token);
        const results = await fetchDocumentSymbols(ctx.workspaceId, ctx.lspUri, signal);
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
      const ctx = modelLspContext(model);
      if (!ctx) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const result = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "semanticTokens",
            { workspaceId: ctx.workspaceId, uri: ctx.lspUri },
            { signal },
          ),
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
