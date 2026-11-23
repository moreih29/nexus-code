import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { WORKSPACE_URI_SCHEME, workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import type { SymbolInformation } from "../../../../shared/lsp";
import { resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { useActiveStore } from "../../../state/stores/active";
import {
  getEntryLspVersion,
  rehydrateLspForWorkspace,
  resetLspStateForWorkspace,
} from "../model/cache";
import { isKnownModelUri, registerKnownModelUri, unregisterKnownModelUri } from "./known-uris";
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
} from "./monaco-converters";
import { notifyDidChange, notifyDidClose, notifyDidOpen, notifyDidSave } from "./notifiers";
import {
  ensureProvidersFor,
  fetchDocumentSymbols,
  getMonacoRef,
  initProviderRegistry,
  setPreAcquireFn as setPreAcquireFnInRegistry,
} from "./provider-registry";
import { applyWorkspaceEdit } from "./workspace-edit";

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

let diagnosticsUnlisten: (() => void) | null = null;
let modelDisposeListener: Monaco.IDisposable | null = null;
let applyEditUnlisten: (() => void) | null = null;
let workspaceResetUnlisten: (() => void) | null = null;

function setMonaco(monaco: typeof Monaco): void {
  if (getMonacoRef() === monaco) return;

  initProviderRegistry(monaco);
  diagnosticsUnlisten?.();
  diagnosticsUnlisten = null;
  modelDisposeListener?.dispose();
  modelDisposeListener = null;
  applyEditUnlisten?.();
  applyEditUnlisten = null;
  workspaceResetUnlisten?.();
  workspaceResetUnlisten = null;
}

function registerDiagnosticsListener(monaco: typeof Monaco): void {
  if (diagnosticsUnlisten) return;

  diagnosticsUnlisten = ipcListen("lsp", "diagnostics", (args) => {
    const absolutePath = fileUriToAbsolutePath(args.uri);
    if (absolutePath === null) return;
    const cacheUri = workspaceUriFor(args.workspaceId, absolutePath);
    const model = monaco.editor.getModel(monaco.Uri.parse(cacheUri));
    if (!model) return;

    if (!isKnownModelUri(cacheUri) && !isKnownModelUri(model.uri.toString())) return;

    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      args.diagnostics.map((diagnostic) => lspDiagnosticToMonacoMarker(monaco, diagnostic)),
    );
  });
}

export function clearLspDiagnostics(workspaceId: string, languageId: string): void {
  const monaco = getMonacoRef();
  if (!monaco) return;
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== WORKSPACE_URI_SCHEME || model.uri.authority !== workspaceId) continue;
    if (resolveLspPresetLanguageId(model.getLanguageId()) !== languageId) continue;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }
}

function registerModelDisposeListener(monaco: typeof Monaco): void {
  if (modelDisposeListener) return;

  modelDisposeListener = monaco.editor.onWillDisposeModel((model) => {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  });
}

function registerWorkspaceResetListener(): void {
  if (workspaceResetUnlisten) return;

  workspaceResetUnlisten = ipcListen("lsp", "workspaceReset", (args) => {
    resetLspStateForWorkspace(args.workspaceId, args.languageId);
    if (args.reopen && useActiveStore.getState().activeWorkspaceId === args.workspaceId) {
      rehydrateLspForWorkspace(args.workspaceId, args.languageId);
    }
  });
}

function registerApplyEditListener(monaco: typeof Monaco): void {
  if (applyEditUnlisten) return;

  applyEditUnlisten = ipcListen("lsp", "applyEdit", (args) => {
    const result = (() => {
      try {
        return applyWorkspaceEdit(monaco, args.params, {
          workspaceId: args.workspaceId,
          lspVersionOf: (model) => getEntryLspVersion(model.uri.toString()) ?? undefined,
        });
      } catch (error) {
        return { applied: false, failureReason: String(error) };
      }
    })();

    void ipcCallResult("lsp", "applyEditResult", { requestId: args.requestId, result });
  });
}

export function setPreAcquireFn(fn: Parameters<typeof setPreAcquireFnInRegistry>[0]): void {
  setPreAcquireFnInRegistry(fn);
}

export function initializeLspBridge(monaco: typeof Monaco): void {
  setMonaco(monaco);
  registerDiagnosticsListener(monaco);
  registerModelDisposeListener(monaco);
  registerApplyEditListener(monaco);
  registerWorkspaceResetListener();
}

export {
  ensureProvidersFor,
  fetchDocumentSymbols,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  notifyDidSave,
  registerKnownModelUri,
  unregisterKnownModelUri,
};

export async function provideWorkspaceSymbols(
  monaco: typeof Monaco,
  workspaceId: string,
  query: string,
  signal?: AbortSignal,
): Promise<WorkspaceSymbolResult[]> {
  if (query.trim().length < 1) return [];

  const symbols = unwrapIpcResult(
    await ipcCallResult("lsp", "workspaceSymbol", { workspaceId, query }, { signal }),
  );
  return symbols.map((symbol: SymbolInformation) =>
    lspSymbolInformationToWorkspaceSymbol(monaco, symbol, workspaceId),
  );
}
