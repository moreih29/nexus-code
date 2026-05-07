// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

import type * as Monaco from "monaco-editor";
import type {
  DocumentSymbol,
  SymbolInformation,
  TextDocumentContentChangeEvent,
} from "../../../shared/lsp-types";
import { ipcCall, ipcListen } from "../../ipc/client";
import { isLspLanguage } from "./language";
import {
  lspDiagnosticToMonacoMarker,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspSymbolInformationToWorkspaceSymbol,
  monacoContentChangesToLsp,
  monacoContentChangeToLsp,
  tokenToAbortSignal,
  type WorkspaceSymbolResult,
} from "./lsp-monaco-converters";
import { registerLanguageProviders } from "./lsp-providers";
import { applyWorkspaceEdit } from "./lsp-workspace-edit";

export type { WorkspaceSymbolResult };
export {
  applyWorkspaceEdit,
  lspDiagnosticToMonacoMarker,
  lspDocumentHighlightToMonacoHighlight,
  lspDocumentSymbolToMonacoSymbol,
  lspLocationToMonacoLocation,
  lspSymbolInformationToWorkspaceSymbol,
  monacoContentChangesToLsp,
  monacoContentChangeToLsp,
  tokenToAbortSignal,
};

const MARKER_OWNER = "lsp";

const registeredProviderLanguages = new Set<string>();
const knownModelUris = new Set<string>();

let monacoRef: typeof Monaco | null = null;
let diagnosticsUnlisten: (() => void) | null = null;
let applyEditUnlisten: (() => void) | null = null;

function setMonaco(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;

  monacoRef = monaco;
  registeredProviderLanguages.clear();
  diagnosticsUnlisten?.();
  diagnosticsUnlisten = null;
  applyEditUnlisten?.();
  applyEditUnlisten = null;
}

function registerDiagnosticsListener(monaco: typeof Monaco): void {
  if (diagnosticsUnlisten) return;

  diagnosticsUnlisten = ipcListen("lsp", "diagnostics", (args) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(args.uri));
    if (!model) return;

    const modelUri = model.uri.toString();
    if (!knownModelUris.has(args.uri) && !knownModelUris.has(modelUri)) return;

    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      args.diagnostics.map((diagnostic) => lspDiagnosticToMonacoMarker(monaco, diagnostic)),
    );
  });
}

function registerApplyEditListener(monaco: typeof Monaco): void {
  if (applyEditUnlisten) return;

  applyEditUnlisten = ipcListen("lsp", "applyEdit", (args) => {
    const result = (() => {
      try {
        return applyWorkspaceEdit(monaco, args.params);
      } catch (error) {
        return { applied: false, failureReason: String(error) };
      }
    })();

    ipcCall("lsp", "applyEditResult", { requestId: args.requestId, result }).catch(() => {});
  });
}

export function initializeLspBridge(monaco: typeof Monaco): void {
  setMonaco(monaco);
  registerDiagnosticsListener(monaco);
  registerApplyEditListener(monaco);
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
  );
}

export function registerKnownModelUri(uri: string): void {
  knownModelUris.add(uri);
}

export function unregisterKnownModelUri(uri: string): void {
  knownModelUris.delete(uri);
}

export function notifyDidOpen(
  uri: string,
  workspaceId: string,
  workspaceRoot: string,
  languageId: string,
  version: number,
  text: string,
): Promise<void> {
  return ipcCall("lsp", "didOpen", { workspaceId, workspaceRoot, uri, languageId, version, text });
}

export function notifyDidChange(
  uri: string,
  version: number,
  contentChanges: TextDocumentContentChangeEvent[],
): Promise<void> {
  return ipcCall("lsp", "didChange", { uri, version, contentChanges });
}

export function notifyDidSave(uri: string, text?: string): Promise<void> {
  return ipcCall("lsp", "didSave", { uri, text });
}

export function notifyDidClose(uri: string): Promise<void> {
  return ipcCall("lsp", "didClose", { uri });
}

export function fetchDocumentSymbols(uri: string, signal?: AbortSignal): Promise<DocumentSymbol[]> {
  return ipcCall("lsp", "documentSymbol", { uri }, { signal });
}

export async function provideWorkspaceSymbols(
  monaco: typeof Monaco,
  workspaceId: string,
  query: string,
  signal?: AbortSignal,
): Promise<WorkspaceSymbolResult[]> {
  if (query.trim().length < 1) return [];

  const symbols = await ipcCall("lsp", "workspaceSymbol", { workspaceId, query }, { signal });
  return symbols.map((symbol: SymbolInformation) =>
    lspSymbolInformationToWorkspaceSymbol(monaco, symbol),
  );
}
