// Monaco language provider registrations for LSP features.
// No module-level state — all state (registeredProviderLanguages) is managed by the caller.

import i18next from "i18next";
import type * as Monaco from "monaco-editor";
import { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import { parseWorkspaceUri } from "../../../../shared/fs/workspace-uri";
import type { CompletionItem } from "../../../../shared/lsp";
import { resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import { CANONICAL_TOKEN_TYPES } from "../../../../shared/lsp/semantic-tokens";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import {
  isLspServerBusy,
  lspStatusKey,
  useLspStatusStore,
} from "../../../state/stores/lsp-status";
import { isLspLanguage } from "./language";
import {
  hoverContentsToMarkdown,
  lspCompletionItemDetails,
  lspCompletionItemToMonaco,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspRangeToMonacoRange,
  tokenToAbortSignal,
} from "./monaco-converters";

// Every character a preset's server completes on; main drops the ones the
// file's own server does not list. rust-analyzer adds ":" (paths) and "(".
const COMPLETION_TRIGGER_CHARACTERS = [".", '"', "'", "/", "@", "<", "[", ":", "("];

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

/**
 * In place of no hover while the server starts or loads the project: says
 * it is not ready, rather than leaving the user to think there is nothing
 * to show. Only over a word, as a real hover would be.
 */
function preparingHover(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  workspaceId: string,
): Monaco.languages.Hover | null {
  const languageId = resolveLspPresetLanguageId(model.getLanguageId());
  if (!languageId || !isLspServerBusy(workspaceId, languageId)) return null;
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const language = i18next.t(`lsp.language.${languageId}`);
  const progress = useLspStatusStore.getState().progress[lspStatusKey(workspaceId, languageId)];
  const detail = [progress?.title, progress?.message].filter(Boolean).join(" — ");
  const text = i18next.t("lsp.preparing", { language });
  return {
    contents: [{ value: detail ? `${text}\n\n${detail}` : text }],
    range: new monaco.Range(
      position.lineNumber,
      word.startColumn,
      position.lineNumber,
      word.endColumn,
    ),
  };
}

/** Curried pre-acquire closure: takes locations + source URI, returns Promise. */
export type PreAcquireFn = (
  locations: readonly Monaco.languages.Location[],
  sourceUri: string,
  token?: Monaco.CancellationToken,
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
      if (!ctx) return null;
      try {
        const signal = tokenToAbortSignal(token);
        const result = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "hover",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
            },
            { signal },
          ),
        );
        if (!isLspLanguage(model.getLanguageId())) return null;
        if (!result) return preparingHover(monaco, model, position, ctx.workspaceId);
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
        await preAcquire(monacoLocations, model.uri.toString(), token);
        return monacoLocations;
      } catch {
        return null;
      }
    },
  });

  // What an item came from, for resolving it once it is picked.
  const completionOrigins = new WeakMap<
    Monaco.languages.CompletionItem,
    { workspaceId: string; lspUri: string; item: CompletionItem }
  >();

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
    async provideCompletionItems(model, position, context, token) {
      if (!isLspLanguage(model.getLanguageId())) return { suggestions: [] };
      const ctx = modelLspContext(model);
      if (!ctx) return { suggestions: [] };
      try {
        const signal = tokenToAbortSignal(token);
        const list = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "completion",
            {
              workspaceId: ctx.workspaceId,
              uri: ctx.lspUri,
              line: position.lineNumber - 1,
              character: position.column - 1,
              // Monaco numbers trigger kinds from 0, LSP from 1.
              triggerKind: context.triggerKind + 1,
              triggerCharacter: context.triggerCharacter,
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
          incomplete: list.isIncomplete,
          suggestions: list.items.map((item) => {
            const suggestion = lspCompletionItemToMonaco(monaco, item, position, range);
            completionOrigins.set(suggestion, { ...ctx, item });
            return suggestion;
          }),
        };
      } catch {
        return { suggestions: [] };
      }
    },
    // Servers leave documentation, detail and the edits an auto-import
    // makes until an item is picked; Monaco asks for them here.
    async resolveCompletionItem(suggestion, token) {
      const origin = completionOrigins.get(suggestion);
      if (!origin) return suggestion;
      try {
        const signal = tokenToAbortSignal(token);
        const item = unwrapIpcResult(
          await ipcCallResult(
            "lsp",
            "completionResolve",
            { workspaceId: origin.workspaceId, uri: origin.lspUri, item: origin.item },
            { signal },
          ),
        );
        // Only these may change on resolve; the range and text stay.
        const resolved = lspCompletionItemDetails(item);
        return {
          ...suggestion,
          detail: resolved.detail ?? suggestion.detail,
          documentation: resolved.documentation ?? suggestion.documentation,
          additionalTextEdits: resolved.additionalTextEdits ?? suggestion.additionalTextEdits,
        };
      } catch {
        return suggestion;
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
        await preAcquire(monacoLocations, model.uri.toString(), token);
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
