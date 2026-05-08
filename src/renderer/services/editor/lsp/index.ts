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
export { isLspLanguage, LSP_LANGUAGES, type LspLanguage } from "./language";
export {
  preAcquireLocationModels,
  PEEK_PREACQUIRE_HOLD_MS,
  type PreAcquireDeps,
  type CacheEntryMeta,
} from "./lsp-result-preacquire";
export type { PreAcquireFn } from "./lsp-providers";
