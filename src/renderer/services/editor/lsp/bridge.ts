// LSP provider registration + diagnostics dispatch.
// Extracted from EditorView so providers are registered once per workspace, not per editor instance.

import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import type {
  DocumentSymbol,
  SymbolInformation,
  TextDocumentContentChangeEvent,
} from "../../../../shared/lsp";
import type { LspLanguageId } from "../../../../shared/types/app-state";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../../ipc/client";
import { useActiveStore } from "../../../state/stores/active";
import { isLspEnabledForWorkspace, useLspEnabledStore } from "../../../state/stores/lsp-enabled";
import { rehydrateLspForWorkspace, resetLspStateForWorkspace } from "../model/cache";
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
} from "./monaco-converters";
import { type PreAcquireFn, registerLanguageProviders } from "./providers";
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

const registeredProviderLanguages = new Set<string>();
const knownModelUris = new Set<string>();

let monacoRef: typeof Monaco | null = null;
let diagnosticsUnlisten: (() => void) | null = null;
let applyEditUnlisten: (() => void) | null = null;
let workspaceResetUnlisten: (() => void) | null = null;
let enabledLanguagesChangedUnlisten: (() => void) | null = null;
let preAcquireFn: PreAcquireFn = async () => {};

function setMonaco(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;

  monacoRef = monaco;
  registeredProviderLanguages.clear();
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

    if (!knownModelUris.has(cacheUri) && !knownModelUris.has(model.uri.toString())) return;

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
export function setPreAcquireFn(fn: PreAcquireFn): void {
  preAcquireFn = fn;
}

export function initializeLspBridge(monaco: typeof Monaco): void {
  setMonaco(monaco);
  registerDiagnosticsListener(monaco);
  registerApplyEditListener(monaco);
  registerWorkspaceResetListener();
  registerEnabledLanguagesChangedListener();
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

export function fetchDocumentSymbols(
  workspaceId: string,
  uri: string,
  signal?: AbortSignal,
): Promise<DocumentSymbol[]> {
  return ipcCallResult("lsp", "documentSymbol", { workspaceId, uri }, { signal }).then(
    unwrapIpcResult,
  );
}

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
