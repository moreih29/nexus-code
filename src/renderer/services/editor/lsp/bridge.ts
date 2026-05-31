// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import type { SymbolInformation } from "../../../../shared/lsp";
import type { LspLanguageId } from "../../../../shared/types/app-state";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { useActiveStore } from "../../../state/stores/active";
import { isLspEnabledForWorkspace, useLspEnabledStore } from "../../../state/stores/lsp-enabled";
import { rehydrateLspForWorkspace, resetLspStateForWorkspace } from "../model/cache";
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
let applyEditUnlisten: (() => void) | null = null;
let workspaceResetUnlisten: (() => void) | null = null;
let enabledLanguagesChangedUnlisten: (() => void) | null = null;

function setMonaco(monaco: typeof Monaco): void {
  if (getMonacoRef() === monaco) return;

  initProviderRegistry(monaco);
  diagnosticsUnlisten?.();
  diagnosticsUnlisten = null;
  applyEditUnlisten?.();
  applyEditUnlisten = null;
  workspaceResetUnlisten?.();
  workspaceResetUnlisten = null;
  enabledLanguagesChangedUnlisten?.();
  enabledLanguagesChangedUnlisten = null;
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

function registerWorkspaceResetListener(): void {
  if (workspaceResetUnlisten) return;

  // The main-side LSP host emits `workspaceReset` when its LRU cap
  // evicts a workspace's servers. We mirror that into the renderer's
  // model cache so every entry's `lspOpened` is cleared; the user's
  // next interaction (typing, or workspace activation) triggers a
  // fresh didOpen and respawns the LSP. Without this, the entries
  // would think the file is still open server-side and silently land
  // didChange notifications in the void.
  workspaceResetUnlisten = ipcListen("lsp", "workspaceReset", (args) => {
    resetLspStateForWorkspace(args.workspaceId, args.languageId);
  });
}

function registerEnabledLanguagesChangedListener(): void {
  if (enabledLanguagesChangedUnlisten) return;

  enabledLanguagesChangedUnlisten = ipcListen("lsp", "enabledLanguagesChanged", (args) => {
    const { workspaceId, languages } = args as {
      workspaceId: string;
      languages: LspLanguageId[];
    };

    // Compute the newly-added languages before updating the store so we
    // can trigger a rehydrate for them on the active workspace.
    const prev = useLspEnabledStore.getState().byWorkspace[workspaceId] ?? [];
    const prevSet = new Set<string>(prev);
    const added = languages.filter((lang) => !prevSet.has(lang));

    // Update the store — this also unblocks future isLspEnabledForWorkspace reads.
    useLspEnabledStore.getState().setForWorkspace(workspaceId, languages);

    // For newly-added languages, eagerly rehydrate if the workspace is
    // currently active. The workspaceReset broadcast handles removed languages.
    if (added.length > 0) {
      const activeWorkspaceId = useActiveStore.getState().activeWorkspaceId;
      if (activeWorkspaceId === workspaceId) {
        for (const lang of added) {
          // isLspEnabledForWorkspace now returns true after the store update above.
          if (isLspEnabledForWorkspace(workspaceId, lang)) {
            rehydrateLspForWorkspace(workspaceId, lang);
          }
        }
      }
    }
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
  registerApplyEditListener(monaco);
  registerWorkspaceResetListener();
  registerEnabledLanguagesChangedListener();
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
