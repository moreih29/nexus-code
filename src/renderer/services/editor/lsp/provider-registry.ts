import type * as Monaco from "monaco-editor";
import type { DocumentSymbol } from "../../../../shared/lsp";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";
import { isLspLanguage } from "./language";
import { type PreAcquireFn, registerLanguageProviders } from "./providers";

let monacoRef: typeof Monaco | null = null;

const registeredProviderLanguages = new Set<string>();

let preAcquireFn: PreAcquireFn = async () => {};

export function initProviderRegistry(monaco: typeof Monaco): void {
  monacoRef = monaco;
  registeredProviderLanguages.clear();
}

export function setPreAcquireFn(fn: PreAcquireFn): void {
  preAcquireFn = fn;
}

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

export function fetchDocumentSymbols(
  workspaceId: string,
  uri: string,
  signal?: AbortSignal,
): Promise<DocumentSymbol[]> {
  return ipcCallResult("lsp", "documentSymbol", { workspaceId, uri }, { signal }).then(
    unwrapIpcResult,
  );
}

export function getMonacoRef(): typeof Monaco | null {
  return monacoRef;
}
