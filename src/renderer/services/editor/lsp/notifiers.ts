import type { TextDocumentContentChangeEvent } from "../../../../shared/lsp";
import { ipcCallResult, unwrapIpcResult } from "../../../ipc/client";

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

export function notifyDidSave(workspaceId: string, uri: string, text?: string): Promise<void> {
  return ipcCallResult("lsp", "didSave", { workspaceId, uri, text }).then(unwrapIpcResult);
}

export function notifyDidClose(workspaceId: string, uri: string): Promise<void> {
  return ipcCallResult("lsp", "didClose", { workspaceId, uri }).then(unwrapIpcResult);
}
