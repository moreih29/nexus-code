// ModelEntry lifecycle — creation, disk load, external-change reconcile, cleanup.
// Owns: model creation, dirty-tracker attachment, LSP open/change/close, fs subscription.

import type * as Monaco from "monaco-editor";
import { type FileErrorCode, parseFileErrorCode } from "../../../utils/file-error";
import { isLspLanguage } from "../lsp/language";
import {
  ensureProvidersFor,
  monacoContentChangesToLsp,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  registerKnownModelUri,
  unregisterKnownModelUri,
} from "../lsp/bridge";
import { requireMonaco } from "../runtime/monaco-singleton";
import type { EditorInput } from "../types";
import { attachDirtyAndUriTracking } from "./attach-dirty-and-uri-tracking";
import { attachFsSubscription } from "./attach-fs-subscription";
import { attachGitSubscription } from "./attach-git-subscription";
import { attachLspBridge } from "./attach-lsp-bridge";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  markSaved as markDirtyTrackerSaved,
} from "./dirty-tracker";
import {
  readFileForModel,
  subscribeFsChanged,
  subscribeGitStatusChanged,
  workspaceRootForInput,
} from "./file-loader";
import { readAndPlaceContent } from "./read-and-place-content";

const defaultModelEntryDeps = {
  attachDirtyTracker,
  detachDirtyTracker,
  markDirtyTrackerSaved,
  readFileForModel,
  subscribeFsChanged,
  subscribeGitStatusChanged,
  attachGitSubscription,
  workspaceRootForInput,
  isLspLanguage,
  ensureProvidersFor,
  monacoContentChangesToLsp,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  registerKnownModelUri,
  unregisterKnownModelUri,
  requireMonaco: () => requireMonaco(),
};

export type ModelEntryDeps = typeof defaultModelEntryDeps;

export type SharedModelPhase = "loading" | "ready" | "binary" | "error";

export interface SharedModelState {
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  readOnly: boolean;
  /** Present when the on-disk file has changed while the buffer has unsaved edits. */
  diskDiverged?: { mtime: string; size: number };
}

export interface ModelEntry {
  input: EditorInput;
  cacheUri: string;
  lspUri: string;
  monacoUri: Monaco.Uri;
  languageId: string;
  refCount: number;
  version: number;
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  lastLoadedValue: string;
  loadPromise: Promise<void>;
  contentDisposable?: Monaco.IDisposable;
  fsUnsubscribe?: () => void;
  gitUnsubscribe?: () => void;
  lspOpened: boolean;
  didOpenPromise?: Promise<void>;
  lspDegraded?: boolean;
  disposed: boolean;
  subscribers: Set<() => void>;
  origin: "workspace" | "external";
  readOnly: boolean;
  deps?: ModelEntryDeps;
  /** Set only when origin === "external"; identifies the workspace the opener came from. */
  originatingWorkspaceId?: string;
  /**
   * Set when the on-disk file has changed while the buffer has unsaved edits.
   * Holds the mtime/size that the disk currently has. Cleared when the entry
   * is re-synced with disk (non-dirty reload, explicit reload, or successful save).
   */
  diskDiverged?: { mtime: string; size: number };
}

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
  const origin: "workspace" | "external" = input.origin ?? "workspace";
  const readOnly = input.readOnly === true;
  const entryInput = input;
  const entry: ModelEntry = {
    input: entryInput,
    cacheUri,
    lspUri: monacoUri.toString(),
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
    await depsFor(entry).notifyDidClose(entry.lspUri);
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
    ? deps.notifyDidClose(entry.lspUri)
    : notifyDidCloseAfterDidOpen(entry);
  didClosePromise.catch(() => {
    entry.lspDegraded = true;
  });

  if (entry.model && !entry.model.isDisposed()) {
    entry.model.dispose();
  }

  entry.subscribers.clear();
}
