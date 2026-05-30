// ModelEntry lifecycle — creation, disk load, external-change reconcile, cleanup.
// Owns: model creation, dirty-tracker attachment, LSP open/change/close, fs subscription.

import { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import { isLspEnabledForWorkspace } from "../../../state/stores/lsp-enabled";
import { type FileErrorCode, parseFileErrorCode } from "../../../utils/file-error";
import { registerKnownModelUri, unregisterKnownModelUri } from "../lsp/known-uris";
import { isLspLanguage } from "../lsp/language";
import { monacoContentChangesToLsp } from "../lsp/monaco-converters";
import { notifyDidChange, notifyDidClose, notifyDidOpen } from "../lsp/notifiers";
import { ensureProvidersFor } from "../lsp/provider-registry";
import { requireMonaco } from "../runtime/monaco-singleton";
import type { EditorInput } from "../types";
import { attachDirtyAndUriTracking } from "./attach-dirty-and-uri-tracking";
import { attachFsSubscription } from "./attach-fs-subscription";
import { attachGitSubscription } from "./attach-git-subscription";
import { attachLspBridge, rehydrateEntryLspOpened } from "./attach-lsp-bridge";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  getDirtyEntry,
  markSaved as markDirtyTrackerSaved,
} from "./dirty-tracker";
import {
  readFileForModel,
  subscribeFsChanged,
  subscribeGitStatusChanged,
  workspaceRootForInput,
} from "./file-loader";
import { readAndPlaceContent } from "./read-and-place-content";
import type { ModelEntry, ModelEntryDeps, SharedModelState } from "./types";

// Types (ModelEntry, ModelEntryDeps, SharedModelPhase, SharedModelState) live in
// ./types to break circular-import cycles with attach-* helpers and cache.ts.
// Re-export them so callers that imported from entry continue to compile.
export type { ModelEntry, ModelEntryDeps, SharedModelPhase, SharedModelState } from "./types";

const defaultModelEntryDeps: ModelEntryDeps = {
  attachDirtyTracker,
  detachDirtyTracker,
  markDirtyTrackerSaved,
  readFileForModel,
  subscribeFsChanged,
  subscribeGitStatusChanged,
  attachGitSubscription,
  workspaceRootForInput,
  isLspLanguage,
  isLspEnabledForWorkspace,
  ensureProvidersFor,
  monacoContentChangesToLsp,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  registerKnownModelUri,
  unregisterKnownModelUri,
  requireMonaco: () => requireMonaco(),
  absolutePathToFileUri,
};

/**
 * Map an arbitrary thrown value into the channel-error vocabulary the
 * UI knows how to render. The dirty-tracker, fs IPC, and Monaco model
 * code all surface failures with a `code:` prefix in the message; this
 * helper normalizes that prefix into a `FileErrorCode` and falls back
 * to "unknown" when no prefix is present.
 */
export function errorCodeFromUnknown(error: unknown): FileErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return parseFileErrorCode(message);
}

/**
 * Stable snapshot of an entry suitable for `useSyncExternalStore`'s
 * `getSnapshot` contract. Returns the current phase, the live model
 * (only while phase === "ready" — callers don't see mid-load state),
 * the error code, and the read-only flag. The shape is intentionally
 * narrow so React's referential equality check stays meaningful.
 */
export function snapshot(entry: ModelEntry): SharedModelState {
  return {
    phase: entry.phase,
    model: entry.phase === "ready" ? entry.model : null,
    errorCode: entry.errorCode,
    readOnly: entry.readOnly,
    diskDiverged: entry.diskDiverged,
  };
}

/**
 * Fan a state-change event out to every `useSyncExternalStore`
 * subscriber listening on this entry. Called after any field that
 * `snapshot` reads is mutated.
 */
export function notifySubscribers(entry: ModelEntry): void {
  for (const subscriber of entry.subscribers) {
    subscriber();
  }
}

function depsFor(entry: ModelEntry): ModelEntryDeps {
  return entry.deps ?? defaultModelEntryDeps;
}

/**
 * Re-issue didOpen against the LSP host for entries whose server-side
 * state was dropped (LRU eviction). Wraps `rehydrateEntryLspOpened`
 * with the entry's resolved deps so callers in the cache layer can
 * trigger respawn without threading deps themselves. No-op when the
 * entry is already opened, disposed, or has no model yet.
 */
export function rehydrateEntry(entry: ModelEntry): Promise<void> {
  return rehydrateEntryLspOpened(entry, depsFor(entry));
}

/**
 * Construct a fresh `ModelEntry` and kick off its load. The returned
 * entry is in `phase: "loading"` and its `loadPromise` resolves once
 * `loadEntry` has either filled in the model + LSP/fs wiring (success)
 * or moved the entry to `phase: "error"` with an `errorCode` (failure).
 * Callers should subscribe before awaiting `loadPromise` so the
 * loading→ready transition fires through the same notify path as
 * later updates.
 */
export function createEntry(
  input: EditorInput,
  cacheUri: string,
  deps: ModelEntryDeps = defaultModelEntryDeps,
): ModelEntry {
  const monaco = deps.requireMonaco();
  const monacoUri = monaco.Uri.parse(cacheUri);
  const origin: "workspace" | "external" = (input.origin ?? "workspace") as
    | "workspace"
    | "external";
  const readOnly = input.readOnly === true;
  const entryInput = input;
  // cacheUri carries the workspace-scoped `nexus-ws://` scheme that
  // identifies this entry uniquely per (workspace, file) pair. lspUri is
  // the canonical `file://` form we use in IPC payloads and forward to
  // the LSP server; it is workspace-blind by design. Both forms refer to
  // the same underlying file path on disk — only the routing context
  // differs.
  const lspUri = deps.absolutePathToFileUri(input.filePath);
  const entry: ModelEntry = {
    input: entryInput,
    cacheUri,
    lspUri,
    monacoUri,
    languageId: "",
    refCount: 0,
    version: 1,
    phase: "loading",
    model: null,
    lastLoadedValue: "",
    loadPromise: Promise.resolve(),
    lspOpened: false,
    didOpenPromise: Promise.resolve(),
    lspDegraded: false,
    disposed: false,
    subscribers: new Set(),
    origin,
    readOnly,
    deps,
    originatingWorkspaceId: entryInput.origin === "external" ? entryInput.workspaceId : undefined,
  };

  entry.loadPromise = loadEntry(entry);
  return entry;
}

/**
 * Construct a `ModelEntry` for an untitled (unsaved, no-backing-file) buffer.
 *
 * Unlike `createEntry`, this path:
 *   - Does NOT perform any fs I/O — the model starts with empty content.
 *   - Does NOT attach an LSP bridge — untitled buffers have no file URI to
 *     route to the language server.
 *   - Does NOT subscribe to fs.changed events — there is no file on disk
 *     to watch.
 *   - Immediately moves the entry to `phase: "ready"`.
 *   - Sets up the dirty tracker with `savedAlternativeVersionId=0` so that
 *     the fresh model (whose altVersionId starts at 1) is dirty from the
 *     start — reflecting that there is no save-point to compare against.
 *
 * The `cacheUri` (= monacoUri) should be `untitled://{workspaceId}/Untitled-{N}`
 * — produced by `untitledCacheUriFor` from workspace-uri.ts.
 */
export function createUntitledEntry(
  input: EditorInput,
  cacheUri: string,
  deps: Pick<ModelEntryDeps, "requireMonaco" | "attachDirtyTracker" | "registerKnownModelUri">,
): ModelEntry {
  const monaco = deps.requireMonaco();
  const monacoUri = monaco.Uri.parse(cacheUri);

  const model =
    monaco.editor.getModel(monacoUri) ?? monaco.editor.createModel("", undefined, monacoUri);

  const entry: ModelEntry = {
    input,
    cacheUri,
    // lspUri is unused for untitled entries — no LSP routing ever happens.
    // We set it to the cacheUri as a safe non-empty placeholder so
    // cleanupEntry's unregisterKnownModelUri call is harmless.
    lspUri: cacheUri,
    monacoUri,
    languageId: model.getLanguageId(),
    refCount: 0,
    version: 1,
    phase: "ready",
    model,
    lastLoadedValue: "",
    loadPromise: Promise.resolve(),
    lspOpened: false,
    didOpenPromise: Promise.resolve(),
    lspDegraded: false,
    disposed: false,
    subscribers: new Set(),
    origin: "untitled",
    readOnly: false,
  };

  // Attach the dirty tracker so downstream consumers (tab indicator,
  // save service, close-handler) can observe dirty state normally.
  // Setting savedAlternativeVersionId=0 immediately after attach ensures
  // isDirty=true from the start: a fresh Monaco model's altVersionId
  // begins at 1, which will never equal 0.
  deps.attachDirtyTracker({
    cacheUri,
    model,
    loadedMtime: "",
    loadedSize: 0,
  });
  const dirtyEntry = getDirtyEntry(cacheUri);
  if (dirtyEntry) {
    dirtyEntry.savedAlternativeVersionId = 0;
    dirtyEntry.isDirty = true;
  }

  // Register the cacheUri in the LSP known-model map so that any
  // provider dispatching on URI can find this entry (even though we
  // skip LSP for untitled, registration keeps unregisterKnownModelUri
  // consistent at cleanup time).
  deps.registerKnownModelUri(cacheUri);

  return entry;
}

/**
 * Load the file behind `entry`: read content, place it into a Monaco
 * model, and attach dirty-tracker + LSP didOpen + fs.changed watching.
 * Each phase is delegated to a stage helper in this directory so this
 * function reads as a linear coordinator. On any failure the entry
 * moves to `phase: "error"` with the mapped error code; on disposal
 * mid-load we abandon early without writing partial state.
 */
async function loadEntry(entry: ModelEntry): Promise<void> {
  const deps = depsFor(entry);
  try {
    const workspaceRoot = deps.workspaceRootForInput(entry.input);
    const placed = await readAndPlaceContent(entry.input, entry.monacoUri, deps);
    if (entry.disposed) return;

    if (placed.isBinary) {
      entry.phase = "binary";
      entry.model = null;
      notifySubscribers(entry);
      return;
    }

    entry.model = placed.model;
    entry.languageId = placed.model.getLanguageId();
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.lastLoadedValue = placed.content;

    attachDirtyAndUriTracking({
      cacheUri: entry.cacheUri,
      lspUri: entry.lspUri,
      model: placed.model,
      mtime: placed.mtime,
      sizeBytes: placed.sizeBytes,
      deps,
    });

    const { contentDisposable } = attachLspBridge(entry, workspaceRoot, deps);
    entry.contentDisposable = contentDisposable;

    entry.fsUnsubscribe = attachFsSubscription(entry, deps, () => {
      reconcileExternalChange(entry).catch(() => {});
    });

    // Subscribe to git.statusChanged so that app-initiated workflow mutations
    // (merge, rebase, cherry-pick) trigger reconciliation even when the file's
    // parent directory is not watched by the file-tree watcher and no fs.changed
    // event arrives. Only workspace-origin entries track working-tree files.
    if (entry.origin === "workspace") {
      entry.gitUnsubscribe = deps.attachGitSubscription(entry, deps, () => {
        reconcileExternalChange(entry).catch(() => {});
      });
    }

    notifySubscribers(entry);
  } catch (error) {
    if (entry.disposed) return;
    entry.phase = "error";
    entry.model = null;
    entry.errorCode = errorCodeFromUnknown(error);
    notifySubscribers(entry);
  }
}

/**
 * Re-read the file from disk after fs.changed fires and merge the
 * result back into the entry. If the on-disk content matches the buffer
 * (i.e. the user's edits are identical to the new disk version, or the
 * change originated from the editor's own save) the function is a
 * no-op. If the buffer has unsaved local edits and the disk content
 * has diverged, we leave the buffer alone — conflict resolution is the
 * save layer's job, not the loader's.
 */
export async function reconcileExternalChange(entry: ModelEntry): Promise<void> {
  if (entry.disposed) return;
  const deps = depsFor(entry);

  try {
    const result = await deps.readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      notifySubscribers(entry);
      return;
    }

    const model = entry.model;
    if (!model || model.isDisposed()) return;

    if (model.getValue() !== entry.lastLoadedValue) {
      // Buffer has unsaved edits — do not overwrite the user's work.
      // Record the current disk state so the save layer can detect and
      // surface a conflict to the user.
      entry.diskDiverged = { mtime: result.mtime, size: result.sizeBytes };
      notifySubscribers(entry);
      return;
    }

    entry.lastLoadedValue = result.content;
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.diskDiverged = undefined;
    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    deps.markDirtyTrackerSaved({
      cacheUri: entry.cacheUri,
      model,
      savedAlternativeVersionId: model.getAlternativeVersionId(),
      loadedMtime: result.mtime,
      loadedSize: result.sizeBytes,
    });

    notifySubscribers(entry);
  } catch (error) {
    if (entry.disposed) return;
    entry.phase = "error";
    entry.errorCode = errorCodeFromUnknown(error);
    notifySubscribers(entry);
  }
}

/**
 * Force-reload the entry's buffer from disk, discarding any unsaved edits.
 * Used by the conflict-resolution "reload" path where the user has explicitly
 * chosen to accept the on-disk version. Unlike `reconcileExternalChange`, this
 * runs without a dirty guard and always replaces the buffer.
 *
 * On success: model content = disk content, dirty tracker re-baselined,
 * `diskDiverged` cleared, subscribers notified.
 */
export async function reloadEntryFromDisk(entry: ModelEntry): Promise<void> {
  if (entry.disposed) return;
  const deps = depsFor(entry);

  try {
    const result = await deps.readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      entry.diskDiverged = undefined;
      notifySubscribers(entry);
      return;
    }

    const model = entry.model;
    if (!model || model.isDisposed()) return;

    entry.lastLoadedValue = result.content;
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.diskDiverged = undefined;
    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    deps.markDirtyTrackerSaved({
      cacheUri: entry.cacheUri,
      model,
      savedAlternativeVersionId: model.getAlternativeVersionId(),
      loadedMtime: result.mtime,
      loadedSize: result.sizeBytes,
    });

    notifySubscribers(entry);
  } catch (error) {
    if (entry.disposed) return;
    entry.phase = "error";
    entry.errorCode = errorCodeFromUnknown(error);
    notifySubscribers(entry);
  }
}

async function notifyDidCloseAfterDidOpen(entry: ModelEntry): Promise<void> {
  await entry.didOpenPromise;
  if (!entry.lspOpened) return;

  try {
    await depsFor(entry).notifyDidClose(entry.input.workspaceId, entry.lspUri);
  } catch {
    entry.lspDegraded = true;
  }
}

/**
 * Tear down everything `loadEntry` attached: fs subscription, LSP
 * didChange disposable, dirty tracker, cacheUri/lspUri map entries,
 * and the LSP didClose notification. Idempotent — second call is a
 * no-op via the `disposed` flag. didClose is sequenced after the
 * pending didOpen completes when the entry is closed mid-open, so the
 * server never sees a close-before-open.
 */
export function cleanupEntry(entry: ModelEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  const deps = depsFor(entry);
  entry.fsUnsubscribe?.();
  entry.gitUnsubscribe?.();
  entry.contentDisposable?.dispose();
  deps.detachDirtyTracker(entry.cacheUri);
  deps.unregisterKnownModelUri(entry.cacheUri);
  deps.unregisterKnownModelUri(entry.lspUri);

  const didClosePromise = entry.lspOpened
    ? deps.notifyDidClose(entry.input.workspaceId, entry.lspUri)
    : notifyDidCloseAfterDidOpen(entry);
  didClosePromise.catch(() => {
    entry.lspDegraded = true;
  });

  if (entry.model && !entry.model.isDisposed()) {
    entry.model.dispose();
  }

  entry.subscribers.clear();
}
