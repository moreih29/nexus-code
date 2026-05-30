// Leaf module: pure LSP IPC notification wrappers.
//
// Extracted from bridge.ts so that model/entry.ts can import these without
// depending on the full bridge module (which imports from model/cache,
// creating a cycle). bridge.ts re-imports and re-exports these for callers
// that already import from bridge.
//
// Must NOT import from model/cache or lsp/bridge — this is a true leaf.

import type { TextDocumentContentChangeEvent } from "../../../../shared/lsp";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";

/**
 * Sends `textDocument/didOpen` to the LSP server over IPC. Called when a
 * model is first loaded and the language is LSP-enabled.
 */
export function notifyDidOpen(
  uri: string,
  workspaceId: string,
  workspaceRoot: string,
  languageId: string,
  version: number,
  text: string,
): Promise<void> {
  return ipcCallResult("lsp", "didOpen", {
    workspaceId,
    workspaceRoot,
    uri,
    languageId,
    version,
    text,
  }).then(unwrapIpcResult);
}

/**
 * Sends `textDocument/didChange` to the LSP server with incremental
 * content-change events. Called on every model edit in the bridge's
 * content-change handler.
 */
export function notifyDidChange(
  workspaceId: string,
  uri: string,
  version: number,
  contentChanges: TextDocumentContentChangeEvent[],
): Promise<void> {
  return ipcCallResult("lsp", "didChange", { workspaceId, uri, version, contentChanges }).then(
    unwrapIpcResult,
  );
}

/**
 * Sends `textDocument/didSave` to the LSP server. Called by the save
 * service after a successful file write.
 */
export function notifyDidSave(workspaceId: string, uri: string, text?: string): Promise<void> {
  return ipcCallResult("lsp", "didSave", { workspaceId, uri, text }).then(unwrapIpcResult);
}

/**
 * Sends `textDocument/didClose` to the LSP server. Called during entry
 * cleanup so the server can release per-file state for the URI.
 */
export function notifyDidClose(workspaceId: string, uri: string): Promise<void> {
  return ipcCallResult("lsp", "didClose", { workspaceId, uri }).then(unwrapIpcResult);
}
