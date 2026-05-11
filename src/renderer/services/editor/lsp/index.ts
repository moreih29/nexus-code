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
} from "./lsp-bridge";
export type { PreAcquireFn } from "./lsp-providers";
export {
  type CacheEntryMeta,
  PEEK_PREACQUIRE_HOLD_MS,
  type PreAcquireDeps,
  preAcquireLocationModels,
} from "./lsp-result-preacquire";
