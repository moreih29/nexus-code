// Leaf module: Monaco provider registration state and the ensureProvidersFor
// entry point used by model/entry.ts.
//
// Extracted from bridge.ts so that model/entry.ts can import
// `ensureProvidersFor` without depending on the full bridge module (which
// imports from model/cache, creating a cycle). bridge.ts re-imports and
// re-exports these for backward compatibility.
//
// Must NOT import from model/cache or lsp/bridge — this is a true leaf.

import type * as Monaco from "monaco-editor";
import type { DocumentSymbol } from "../../../../shared/lsp";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { isLspLanguage } from "./language";
import { type PreAcquireFn, registerLanguageProviders } from "./providers";

// --- Module-level state --------------------------------------------------- //

/** Stored Monaco reference set by `initProviderRegistry`. */
let monacoRef: typeof Monaco | null = null;

/** Languages for which Monaco providers have already been registered.
 *  Cleared whenever Monaco is re-initialized so providers are re-registered
 *  with the fresh instance. */
const registeredProviderLanguages = new Set<string>();

/** Pre-acquire function injected by the installation seam at startup.
 *  Defaults to a no-op until `setPreAcquireFn` is called. */
let preAcquireFn: PreAcquireFn = async () => {};

// -------------------------------------------------------------------------- //

/**
 * Store the Monaco reference and clear the registered-language set so
 * providers are re-registered with the new instance. Called by
 * `bridge.initializeLspBridge` on each Monaco initialization.
 */
export function initProviderRegistry(monaco: typeof Monaco): void {
  monacoRef = monaco;
  registeredProviderLanguages.clear();
}

/**
 * Inject the pre-acquire closure produced by the installation seam
 * (monaco-compensations.ts / index.ts). Must be called before any
 * `ensureProvidersFor` invocation that should trigger pre-acquisition.
 */
export function setPreAcquireFn(fn: PreAcquireFn): void {
  preAcquireFn = fn;
}

/**
 * Ensure Monaco language providers are registered for `languageId`.
 * Idempotent — the `registeredProviderLanguages` set prevents
 * double-registration. Throws if the bridge has not been initialized yet.
 */
export function ensureProvidersFor(languageId: string): void {
  if (!isLspLanguage(languageId)) return;
  if (!monacoRef) {
    throw new Error("LSP bridge is not initialized. Call initializeEditorServices(monaco) first.");
  }
  registerLanguageProviders(
    monacoRef,
    languageId,
    registeredProviderLanguages,
    fetchDocumentSymbols,
    preAcquireFn,
  );
}

/**
 * Fetch document symbols for `uri` via IPC. Passed to
 * `registerLanguageProviders` so the outline/breadcrumb providers can
 * request symbols without importing bridge.
 */
export function fetchDocumentSymbols(
  workspaceId: string,
  uri: string,
  signal?: AbortSignal,
): Promise<DocumentSymbol[]> {
  return ipcCallResult("lsp", "documentSymbol", { workspaceId, uri }, { signal }).then(
    unwrapIpcResult,
  );
}

/** Expose the stored Monaco reference for bridge.ts's diagnostics and
 *  apply-edit listeners that also need it. */
export function getMonacoRef(): typeof Monaco | null {
  return monacoRef;
}
