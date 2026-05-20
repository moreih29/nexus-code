/** Sends LSP didOpen and wires the model's content-change listener to forward didChange notifications. */

import type * as Monaco from "monaco-editor";
import { lspLanguageIdForUri, resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import type { ModelEntry, ModelEntryDeps } from "./entry";

export interface AttachLspBridgeResult {
  contentDisposable: Monaco.IDisposable;
}

type RehydrateDeps = Pick<ModelEntryDeps, "notifyDidOpen" | "workspaceRootForInput">;

/**
 * Re-issue `textDocument/didOpen` for an entry whose LSP-side state was
 * dropped (e.g. by the host's LRU eviction). Idempotent — concurrent
 * callers see the same in-flight promise via `entry.didOpenPromise`, so
 * exactly one didOpen is sent per reset.
 *
 * Called from two places:
 *   1. The renderer's `lsp:workspaceReset` listener (eager, when the
 *      workspace becomes active).
 *   2. The content-change handler below (lazy, the next keystroke).
 *
 * On failure we leave `lspDegraded` set so callers can surface a
 * "LSP not responding" hint without retrying indefinitely.
 */
export function rehydrateEntryLspOpened(entry: ModelEntry, deps: RehydrateDeps): Promise<void> {
  // Only meaningful when the host signalled an eviction and asked the
  // renderer to re-issue didOpen. Without the flag we'd also fire here
  // during the initial loading window (lspOpened still false because
  // the first didOpen hasn't resolved yet), racing the first didOpen
  // with itself.
  if (entry.disposed || !entry.model || entry.lspOpened || !entry.lspNeedsRehydrate) {
    return entry.didOpenPromise ?? Promise.resolve();
  }
  // Reset version — the LSP server is fresh and doesn't know any
  // history for this URI. Starting from 1 keeps the change stream
  // consistent with the initial open's version contract.
  entry.version = 1;
  const text = entry.model.getValue();
  const workspaceRoot = deps.workspaceRootForInput(entry.input);
  entry.didOpenPromise = deps
    .notifyDidOpen(
      entry.lspUri,
      entry.input.workspaceId,
      workspaceRoot,
      lspLanguageIdForUri(entry.languageId, entry.lspUri),
      entry.version,
      text,
    )
    .then(
      () => {
        entry.lspOpened = true;
        entry.lspDegraded = false;
        entry.lspNeedsRehydrate = false;
      },
      () => {
        entry.lspOpened = false;
        entry.lspDegraded = true;
        // Leave needsRehydrate set so a subsequent interaction retries.
      },
    );
  return entry.didOpenPromise;
}

export function attachLspBridge(
  entry: ModelEntry,
  workspaceRoot: string,
  deps: Pick<
    ModelEntryDeps,
    | "isLspLanguage"
    | "isLspEnabledForWorkspace"
    | "ensureProvidersFor"
    | "notifyDidOpen"
    | "notifyDidChange"
    | "monacoContentChangesToLsp"
    | "workspaceRootForInput"
  >,
): AttachLspBridgeResult {
  const model = entry.model!;

  if (deps.isLspLanguage(entry.languageId)) {
    // Resolve the canonical preset language id (e.g. "typescriptreact" → "typescript")
    // so the enabled-check uses the same key that main's isLanguageEnabled gate uses.
    const presetLanguageId = resolveLspPresetLanguageId(entry.languageId) ?? entry.languageId;
    if (deps.isLspEnabledForWorkspace(entry.input.workspaceId, presetLanguageId)) {
      deps.ensureProvidersFor(entry.languageId);
      entry.didOpenPromise = deps
        .notifyDidOpen(
          entry.lspUri,
          entry.input.workspaceId,
          workspaceRoot,
          lspLanguageIdForUri(entry.languageId, entry.lspUri),
          entry.version,
          entry.lastLoadedValue,
        )
        .then(
          () => {
            entry.lspOpened = true;
          },
          () => {
            entry.lspOpened = false;
            entry.lspDegraded = true;
          },
        );
    }
  }

  const contentDisposable = model.onDidChangeContent(async (event) => {
    entry.version += 1;
    const version = entry.version;
    const contentChanges = deps.monacoContentChangesToLsp(event.changes);
    if (contentChanges.length === 0) return;
    // Lazy rehydrate: if the host evicted this workspace's LSP since
    // the last interaction, re-open before forwarding the change. The
    // server doesn't know this URI yet, so a bare didChange would land
    // in the void and the next hover would still see no symbols.
    // Gated on `lspNeedsRehydrate` so the initial didOpen window (where
    // lspOpened is still false because the first open hasn't resolved
    // yet) doesn't accidentally trigger a second didOpen.
    if (entry.lspNeedsRehydrate && !entry.disposed && deps.isLspLanguage(entry.languageId)) {
      await rehydrateEntryLspOpened(entry, deps);
    }
    await entry.didOpenPromise;
    if (!entry.lspOpened || entry.disposed) return;
    deps
      .notifyDidChange(entry.input.workspaceId, entry.lspUri, version, contentChanges)
      .catch(() => {
        entry.lspDegraded = true;
      });
  });

  return { contentDisposable };
}
