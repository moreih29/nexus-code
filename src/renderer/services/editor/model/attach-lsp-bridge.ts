/** Sends LSP didOpen and wires the model's content-change listener to forward didChange notifications. */

import type * as Monaco from "monaco-editor";
import { lspLanguageIdForUri, resolveLspPresetLanguageId } from "../../../../shared/lsp/config";
import type { ModelEntry, ModelEntryDeps } from "./types";

export interface AttachLspBridgeResult {
  contentDisposable: Monaco.IDisposable;
}

type RehydrateDeps = Pick<
  ModelEntryDeps,
  "isLspEnabledForWorkspace" | "ensureProvidersFor" | "notifyDidOpen" | "workspaceRootForInput"
>;

/** The language id main's enabled list and server map use for this entry. */
function presetLanguageIdFor(entry: ModelEntry): string {
  return resolveLspPresetLanguageId(entry.languageId) ?? entry.languageId;
}

/**
 * Re-issue `textDocument/didOpen` for an entry whose LSP-side state was
 * dropped (e.g. by the host's LRU eviction), or that loaded while its
 * language was turned off. Idempotent — concurrent callers see the same
 * in-flight promise via `entry.didOpenPromise`, so exactly one didOpen is
 * sent per reset.
 *
 * Called from two places:
 *   1. `rehydrateLspForWorkspace` (eager, when the workspace becomes
 *      active or a language is turned on).
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
  // A rehydrate already in flight covers every keystroke typed while the
  // server starts; a second didOpen would reset the document again.
  // While the language is off, main accepts the didOpen without a server;
  // marking the entry open then would keep it closed once turned on.
  if (
    entry.disposed ||
    !entry.model ||
    entry.lspOpened ||
    !entry.lspNeedsRehydrate ||
    entry.lspRehydrating ||
    !deps.isLspEnabledForWorkspace(entry.input.workspaceId, presetLanguageIdFor(entry))
  ) {
    return entry.didOpenPromise ?? Promise.resolve();
  }
  deps.ensureProvidersFor(entry.languageId);
  // Reset version — the LSP server is fresh and doesn't know any
  // history for this URI. Starting from 1 keeps the change stream
  // consistent with the initial open's version contract.
  entry.version = 1;
  // The text below already holds every change made so far, including the
  // one whose handler is calling us; the new epoch keeps those handlers
  // from sending them again.
  const epoch = (entry.lspOpenEpoch ?? 0) + 1;
  entry.lspOpenEpoch = epoch;
  entry.lspRehydrating = true;
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
        // Evicted again while opening: the reset already asked for a new
        // rehydrate.
        if (entry.lspOpenEpoch !== epoch) return;
        entry.lspRehydrating = false;
        entry.lspOpened = true;
        entry.lspDegraded = false;
        entry.lspNeedsRehydrate = false;
      },
      () => {
        if (entry.lspOpenEpoch !== epoch) return;
        entry.lspRehydrating = false;
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
    if (deps.isLspEnabledForWorkspace(entry.input.workspaceId, presetLanguageIdFor(entry))) {
      deps.ensureProvidersFor(entry.languageId);
      const openEpoch = entry.lspOpenEpoch ?? 0;
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
            // An eviction while opening leaves the entry to rehydrate.
            if ((entry.lspOpenEpoch ?? 0) !== openEpoch) return;
            entry.lspOpened = true;
          },
          () => {
            if ((entry.lspOpenEpoch ?? 0) !== openEpoch) return;
            entry.lspOpened = false;
            entry.lspDegraded = true;
          },
        );
    } else {
      // Opened by `rehydrateLspForWorkspace` once the language is turned on.
      entry.lspNeedsRehydrate = true;
    }
  }

  const contentDisposable = model.onDidChangeContent(async (event) => {
    entry.version += 1;
    const version = entry.version;
    const epoch = entry.lspOpenEpoch ?? 0;
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
    // Already part of a later didOpen's text, or dropped with the server's
    // copy (the next rehydrate sends the whole buffer).
    if ((entry.lspOpenEpoch ?? 0) !== epoch) return;
    deps
      .notifyDidChange(entry.input.workspaceId, entry.lspUri, version, contentChanges)
      .catch(() => {
        entry.lspDegraded = true;
      });
  });

  return { contentDisposable };
}
