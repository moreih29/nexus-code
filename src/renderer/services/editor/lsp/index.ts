/**
 * services/editor/lsp/ — Monaco-bound LSP adapters.
 *
 * Code in this folder bridges Monaco editor instances with the LSP transport:
 * provider registration, document sync, range/marker converters, and the
 * workspace-edit applier. Anything here assumes a Monaco editor or model is
 * available.
 *
 * For editor-independent LSP consumers (server-event UX routing, workspace
 * symbol registry, etc.) see `services/lsp/`.
 */

export { isLspLanguage, LSP_LANGUAGES, type LspLanguage } from "./language";
export {
  applyWorkspaceEdit,
  ensureProvidersFor,
  fetchDocumentSymbols,
  initializeLspBridge,
  lspDiagnosticToMonacoMarker,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspSymbolInformationToWorkspaceSymbol,
  monacoContentChangesToLsp,
  monacoContentChangeToLsp,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  notifyDidSave,
  provideWorkspaceSymbols,
  registerKnownModelUri,
  setPreAcquireFn,
  tokenToAbortSignal,
  unregisterKnownModelUri,
  type WorkspaceSymbolResult,
} from "./bridge";
export type { PreAcquireFn } from "./providers";
export {
  type CacheEntryMeta,
  PEEK_PREACQUIRE_HOLD_MS,
  type PreAcquireDeps,
  preAcquireLocationModels,
} from "./result-preacquire";
