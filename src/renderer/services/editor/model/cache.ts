// Monaco TextModel reference counting.
// Mirrors VSCode ITextModelService — models are owned by the cache, not by editor instances.
// Framework-agnostic surface: acquire/release primitives, subscribeModel, isMonacoReady.
// React binding lives in `./use-shared-model.ts`.

import type * as Monaco from "monaco-editor";
import { fileUriToAbsolutePath } from "../../../../shared/fs/file-uri";
import { parseWorkspaceUri, workspaceUriFor } from "../../../../shared/fs/workspace-uri";
import { registerWorkspaceCleanup } from "../../../state/workspace-cleanup";
import type { FileErrorCode } from "../../../utils/file-error";
import { registerKnownModelUri } from "../lsp/known-uris";
import { initializeMonacoSingleton, requireMonaco } from "../runtime/monaco-singleton";
import { attachDirtyTracker } from "./dirty-tracker";
import {
  cleanupEntry,
  createEntry,
  createUntitledEntry,
  errorCodeFromUnknown,
  notifySubscribers,
  rehydrateEntry,
  reloadEntryFromDisk,
  snapshot,
} from "./entry";
import { loadExternalEntry } from "./load-external-entry";
import type { ModelEntry, SharedModelState } from "./types";

export { isMonacoReady, onMonacoReady } from "../runtime/monaco-singleton";
export type { SharedModelPhase, SharedModelState } from "./types";

import type { EditorInput } from "../types";

export interface ReleasedModelInfo {
  input: EditorInput;
  cacheUri: string;
  lspUri: string;
  languageId: string;
}

export type ModelReleaseSubscriber = (released: ReleasedModelInfo) => void;

/**
 * Build the cacheUri that identifies a (workspace, file) pair in the model
 * cache and Monaco's model registry. The URI uses the `nexus-ws` scheme
 * with the workspaceId in the authority slot, so the SAME physical file
 * opened from two different workspaces produces two distinct cacheUris
 * (and therefore two independent ModelEntry / Monaco TextModel instances).
 *
 * Renderer-only. The main side translates back to a plain file:// URI at
 * the LSP server boundary — see workspace-uri.ts.
 */
export function cacheUriFor(workspaceId: string, filePath: string): string {
  return workspaceUriFor(workspaceId, filePath);
}

/**
 * Inverse of `cacheUriFor`. Returns null when the URI is neither a
 * workspace-scoped cacheUri nor a plain file:// URI — defensive against
 * accidentally slicing unrelated strings. Callers that need the file
 * path of a tracked model should always use this rather than slicing
 * the prefix off inline; the prefix shape is owned here.
 *
 * Accepts both forms:
 *   - `nexus-ws://${workspaceId}${path}` (the canonical cacheUri after
 *     the cross-workspace cache-isolation work).
 *   - `file://${path}` (some upstream paths and historical call sites
 *     still produce file URIs; they round-trip cleanly to the same
 *     absolute path because the workspace prefix only adds routing
 *     context, not a different filesystem identity).
 *
 * Callers that also need the workspaceId should use `parseCacheUri`
 * instead — this helper drops it for the common "I just need the path"
 * call sites that already have workspaceId from another source.
 */
export function cacheUriToFilePath(cacheUri: string): string | null {
  const workspaceParsed = parseWorkspaceUri(cacheUri);
  if (workspaceParsed) return workspaceParsed.absolutePath;
  return fileUriToAbsolutePath(cacheUri);
}

/**
 * Full parse of a cacheUri into its `(workspaceId, filePath)` pair. Use
 * this when both halves are needed (e.g. LSP cross-file navigation
 * routing the open back through the correct workspace).
 */
export function parseCacheUri(cacheUri: string): { workspaceId: string; filePath: string } | null {
  const parsed = parseWorkspaceUri(cacheUri);
  return parsed ? { workspaceId: parsed.workspaceId, filePath: parsed.absolutePath } : null;
}

export function initializeModelCache(monaco: typeof Monaco): void {
  initializeMonacoSingleton(monaco);

  // Evict external models tied to a workspace when that workspace closes.
  // Registering by name (rather than an inline closure) makes this safe
  // against double-init: the Set keeps a single reference.
  registerWorkspaceCleanup(forceDisposeExternalsForWorkspace);
}

const entries = new Map<string, ModelEntry>();
const releaseSubscribers = new Set<ModelReleaseSubscriber>();

function cacheUriForInput(input: EditorInput): string {
  if (input.origin === "untitled") {
    // Untitled buffers use the `untitled://` scheme for workspace isolation.
    // `filePath` for untitled inputs holds the display name (e.g. "Untitled-1"),
    // not an absolute file-system path. The resulting URI is the cacheUri AND
    // the Monaco monacoUri — no separate translation step is needed.
    return `untitled://${input.workspaceId}/${input.filePath}`;
  }
  return cacheUriFor(input.workspaceId, input.filePath);
}

export function subscribeOnRelease(callback: ModelReleaseSubscriber): () => void {
  releaseSubscribers.add(callback);
  return () => {
    releaseSubscribers.delete(callback);
  };
}

function notifyReleased(released: ReleasedModelInfo): void {
  for (const subscriber of releaseSubscribers) {
    try {
      subscriber(released);
    } catch {
      // Release cleanup must not be blocked by secondary cache invalidators.
    }
  }
}

/**
 * Subscribe to phase / model changes for a tracked entry. Returns a
 * no-op when the entry is unknown so callers don't need an extra
 * existence check. The unsubscribe returned removes the listener and
 * is idempotent.
 */
export function subscribeModel(input: EditorInput, onChange: () => void): () => void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return () => {};
  entry.subscribers.add(onChange);
  return () => {
    entry.subscribers.delete(onChange);
  };
}

/**
 * Read the current snapshot for a tracked entry, or null when no entry
 * exists. Pure read — does not affect ref-counts.
 */
export function getModelSnapshot(input: EditorInput): SharedModelState | null {
  const entry = entries.get(cacheUriForInput(input));
  return entry ? snapshot(entry) : null;
}

/**
 * Coerce an arbitrary thrown value to a FileErrorCode. Exposed for the
 * React binding so it can map a rejected acquire promise to the
 * `error` phase without re-implementing the heuristic.
 */
export function toFileErrorCode(error: unknown): FileErrorCode {
  return errorCodeFromUnknown(error);
}

export async function acquireModel(input: EditorInput): Promise<SharedModelState> {
  const cacheUri = cacheUriForInput(input);
  let entry = entries.get(cacheUri);
  if (!entry) {
    if (input.origin === "external") {
      entry = await loadExternalEntry(input);
    } else if (input.origin === "untitled") {
      // Untitled buffers: no fs IPC, no LSP registration, no fs-watcher.
      // The model starts with empty content and is immediately ready.
      entry = createUntitledEntry(input, cacheUri, {
        requireMonaco,
        attachDirtyTracker,
        registerKnownModelUri,
      });
    } else {
      entry = createEntry(input, cacheUri);
    }
    entries.set(cacheUri, entry);
  }

  entry.refCount += 1;
  try {
    await entry.loadPromise;
    return snapshot(entry);
  } catch (error) {
    entry.refCount -= 1;
    if (entry.refCount === 0 && entries.get(cacheUri) === entry) {
      entries.delete(cacheUri);
      cleanupEntry(entry);
    }
    throw error;
  }
}

export function releaseModel(input: EditorInput): void {
  const cacheUri = cacheUriForInput(input);
  const entry = entries.get(cacheUri);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  entries.delete(cacheUri);
  const released: ReleasedModelInfo = {
    input: entry.input,
    cacheUri: entry.cacheUri,
    lspUri: entry.lspUri,
    languageId: entry.languageId,
  };
  cleanupEntry(entry);
  notifyReleased(released);
}

/**
 * Read-only view of a resolved model entry. Exposed for the save-service
 * (and similar consumers) so they can act on a tracked model without
 * having to peek at the entry map directly.
 */
export interface ResolvedModelView {
  model: Monaco.editor.ITextModel;
  cacheUri: string;
  /** Workspace-blind `file://` form used in LSP IPC payloads. */
  lspUri: string;
  workspaceId: string;
  filePath: string;
  languageId: string;
  readOnly: boolean;
}

export function getResolvedModel(input: EditorInput): ResolvedModelView | null {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry || entry.phase !== "ready" || !entry.model) return null;
  return {
    model: entry.model,
    cacheUri: entry.cacheUri,
    lspUri: entry.lspUri,
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    languageId: entry.languageId,
    readOnly: entry.readOnly,
  };
}

/**
 * Lightweight metadata view keyed by cacheUri (rather than EditorInput).
 * Exposed so consumers that hold only a monaco URI (e.g. an LSP provider
 * receiving a model from monaco) can recover the originating workspaceId
 * and origin without having to thread an EditorInput through.
 *
 * Returns null when the URI is not tracked. Read-only — does not affect
 * ref-counts.
 */
export interface EntryMetadata {
  workspaceId: string;
  filePath: string;
  origin: "workspace" | "external" | "untitled";
  readOnly: boolean;
}

export function getEntryMetadata(cacheUri: string): EntryMetadata | null {
  const entry = entries.get(cacheUri);
  if (!entry) return null;
  return {
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    origin: entry.origin,
    readOnly: entry.readOnly,
  };
}

/**
 * Reload the model entry for `input` from disk, replacing the buffer with
 * the on-disk content. Used by the conflict-resolution "reload" path.
 * Returns false when no tracked entry exists for the input.
 */
export async function reloadModelFromDisk(input: EditorInput): Promise<boolean> {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return false;
  await reloadEntryFromDisk(entry);
  return true;
}

/**
 * Clear the `diskDiverged` marker after a successful save so subsequent
 * saves (and the UI) see a clean state. Called by the save service after a
 * write that was preceded by an overwrite conflict-resolution.
 */
export function clearDiskDiverged(input: EditorInput): void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return;
  if (entry.diskDiverged === undefined) return;
  entry.diskDiverged = undefined;
  notifySubscribers(entry);
}

/**
 * Advance the entry's loaded-value baseline to `content` after a successful
 * save. `lastLoadedValue` records "what the buffer matched the last time it
 * was in sync with disk"; reconcileExternalChange compares the live buffer
 * against it to decide whether an fs/git event reflects the user's own write
 * (no-op) or a genuine external change. Without this update the baseline stays
 * frozen at the pre-edit content, so every post-save fs/git event makes
 * reconcile treat the file as externally diverged — a false positive.
 *
 * `content` is the exact text just written to disk (captured by the save
 * service before the write), so the baseline matches the on-disk state.
 */
export function syncLoadedValueAfterSave(input: EditorInput, content: string): void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return;
  entry.lastLoadedValue = content;
}

/**
 * Mark tracked entries as no-longer-opened on the LSP side. The renderer's
 * LSP bridge calls this after receiving `lsp:workspaceReset` from main.
 *
 * When `languageId` is provided only entries for that language within the
 * workspace are reset; when omitted every entry for the workspace is reset
 * (backward-compatible, used by LRU full-workspace eviction).
 *
 * The function only flips bookkeeping fields — actual respawn is
 * lazy (next keystroke triggers rehydrate) and/or eager (workspace
 * activation calls `rehydrateLspForWorkspace`).
 */
export function resetLspStateForWorkspace(workspaceId: string, languageId?: string): void {
  for (const entry of entries.values()) {
    if (entry.input.workspaceId !== workspaceId) continue;
    if (languageId && entry.languageId !== languageId) continue;
    if (entry.disposed) continue;
    entry.lspOpened = false;
    entry.lspNeedsRehydrate = true;
    // Reset the open promise to a settled state so callers awaiting it
    // immediately observe the new lspOpened flag and decide whether to
    // re-issue didOpen.
    entry.didOpenPromise = Promise.resolve();
  }
}

/**
 * Eagerly re-issue didOpen for entries whose LSP server-side state was
 * dropped. Called from the renderer when the workspace becomes active again
 * — without this, the user has to type before hover/completion start working
 * in the revisited workspace.
 *
 * When `languageId` is provided only entries for that language are
 * rehydrated; when omitted every eligible entry for the workspace is
 * rehydrated (backward-compatible, full-workspace path).
 *
 * Errors are swallowed per-entry so a single failed rehydrate doesn't
 * block the rest.
 */
export function rehydrateLspForWorkspace(workspaceId: string, languageId?: string): void {
  for (const entry of entries.values()) {
    if (entry.input.workspaceId !== workspaceId) continue;
    if (languageId && entry.languageId !== languageId) continue;
    if (entry.disposed || entry.lspOpened) continue;
    // Skip entries that have never been opened (initial load still in
    // flight) — only re-issue didOpen for entries the host had once
    // accepted and then evicted.
    if (!entry.lspNeedsRehydrate) continue;
    void rehydrateEntry(entry).catch(() => {
      // rehydrateEntry already records lspDegraded on failure; we keep
      // the loop running so unrelated entries still respawn.
    });
  }
}

/**
 * Force-dispose all external and untitled model entries associated with the
 * given workspaceId. Called when a workspace closes so externally-opened
 * read-only models and unsaved untitled buffers are not held in memory
 * indefinitely.
 *
 * This bypasses the normal refCount mechanism intentionally — the tabs
 * referencing these models are already removed by `closeAllForWorkspace` in
 * the tabs store, so there will be no further release() calls to drain them.
 *
 * Untitled buffers are disposed regardless of dirty state: the workspace
 * itself is gone, so there is no recovery path for any unsaved content.
 */
export function forceDisposeExternalsForWorkspace(workspaceId: string): void {
  for (const [cacheUri, entry] of entries) {
    const isExternalForWorkspace =
      entry.origin === "external" && entry.originatingWorkspaceId === workspaceId;
    const isUntitledForWorkspace =
      entry.origin === "untitled" && entry.input.workspaceId === workspaceId;
    if (isExternalForWorkspace || isUntitledForWorkspace) {
      entries.delete(cacheUri);
      cleanupEntry(entry);
    }
  }
}
