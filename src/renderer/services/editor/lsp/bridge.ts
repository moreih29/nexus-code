// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

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
    // args.uri arrives in `file://` form (what the LSP server emitted).
    // Monaco models are keyed by the workspace-scoped cacheUri
    // (`nexus-ws://${workspaceId}/…`) so we have to reconstruct that
    // identifier from the (workspaceId, uri) pair before looking the
    // model up. Two workspaces holding the same physical file each have
    // their own model — this is exactly the disambiguation step.
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

/**
 * Drops the diagnostics a workspace's `languageId` server published: once
 * it is turned off or failed for good, no server will replace them.
 */
export function clearLspDiagnostics(workspaceId: string, languageId: string): void {
  const monaco = getMonacoRef();
  if (!monaco) return;
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== WORKSPACE_URI_SCHEME || model.uri.authority !== workspaceId) continue;
    if (resolveLspPresetLanguageId(model.getLanguageId()) !== languageId) continue;
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  }
}

/**
 * Drops a closing file's diagnostics. Monaco keeps markers by URI past the
 * model, and the file reopened would show them until its server published
 * again, or for good when it does not (a file outside the project).
 */
function registerModelDisposeListener(monaco: typeof Monaco): void {
  if (modelDisposeListener) return;

  modelDisposeListener = monaco.editor.onWillDisposeModel((model) => {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
  });
}

function registerWorkspaceResetListener(): void {
  if (workspaceResetUnlisten) return;

  // The main-side LSP host emits `workspaceReset` when it stops a
  // workspace's servers (LRU cap, crash, a setting). We mirror that into
  // the renderer's model cache so every entry's `lspOpened` is cleared;
  // the user's next interaction (typing, or workspace activation)
  // triggers a fresh didOpen and respawns the LSP. Without this, the
  // entries would think the file is still open server-side and silently
  // land didChange notifications in the void. A restart (`reopen`)
  // reopens the active workspace's documents at once.
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

    // Fire-and-forget: applyEditResult is a one-shot ack; LSP server handles timeouts.
    void ipcCallResult("lsp", "applyEditResult", { requestId: args.requestId, result });
  });
}

/**
 * Inject the pre-acquire closure produced by the installation seam
 * (monaco-compensations.ts / index.ts). Must be called before any
 * `ensureProvidersFor` invocation that should trigger pre-acquisition.
 */
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

// Re-exported from leaf modules so existing callers that import these from
// bridge continue to work without changes.
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
