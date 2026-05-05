// Monaco TextModel reference counting.
// Mirrors VSCode ITextModelService — models are owned by the cache, not by editor instances.
// Framework-agnostic surface: acquire/release primitives, subscribeModel, isMonacoReady.
// React binding lives in `./use-shared-model.ts`.

import type * as Monaco from "monaco-editor";
import { type FileErrorCode, parseFileErrorCode } from "../../utils/file-error";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  markSaved as markDirtyTrackerSaved,
} from "./dirty-tracker";
import { readFileForModel, subscribeFsChanged } from "./file-loader";
import { isLspLanguage } from "./language";
import {
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  registerKnownModelUri,
  unregisterKnownModelUri,
} from "./lsp-bridge";
import type { EditorInput } from "./types";

export type SharedModelPhase = "loading" | "ready" | "binary" | "error";

export interface SharedModelState {
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
}

interface ModelEntry {
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
  lspOpened: boolean;
  disposed: boolean;
  subscribers: Set<() => void>;
}

let monacoRef: typeof Monaco | null = null;

const entries = new Map<string, ModelEntry>();
const initializeListeners = new Set<() => void>();

export function initializeModelCache(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;
  monacoRef = monaco;
  for (const listener of initializeListeners) {
    listener();
  }
}

export function filePathToModelUri(filePath: string): string {
  return `file://${filePath}`;
}

/**
 * Inverse of `filePathToModelUri`. Returns null when the cacheUri is not
 * one we produced (defensive — protects callers from mistakenly slicing
 * an unrelated string). Callers that need the file path of a tracked
 * model should always use this rather than slicing the prefix off
 * inline; the prefix shape is owned here.
 */
export function cacheUriToFilePath(cacheUri: string): string | null {
  return cacheUri.startsWith("file://") ? cacheUri.slice("file://".length) : null;
}

function requireMonaco(): typeof Monaco {
  if (!monacoRef) {
    throw new Error("Monaco is not initialized. Call initializeEditorServices(monaco) first.");
  }
  return monacoRef;
}

function snapshot(entry: ModelEntry): SharedModelState {
  return {
    phase: entry.phase,
    model: entry.phase === "ready" ? entry.model : null,
    errorCode: entry.errorCode,
  };
}

function notifySubscribers(entry: ModelEntry): void {
  for (const subscriber of entry.subscribers) {
    subscriber();
  }
}

function errorCodeFromUnknown(error: unknown): FileErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return parseFileErrorCode(message);
}

function createEntry(input: EditorInput): ModelEntry {
  const monaco = requireMonaco();
  const cacheUri = filePathToModelUri(input.filePath);
  const monacoUri = monaco.Uri.parse(cacheUri);
  // languageId is resolved by Monaco from the URI's extension at model
  // creation time (see loadEntry). Initialized empty here so the entry
  // shape is complete before loadEntry assigns the real id.
  const entry: ModelEntry = {
    input,
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
    disposed: false,
    subscribers: new Set(),
  };

  entry.loadPromise = loadEntry(entry);
  return entry;
}

async function loadEntry(entry: ModelEntry): Promise<void> {
  try {
    const result = await readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      entry.model = null;
      notifySubscribers(entry);
      return;
    }

    const monaco = requireMonaco();
    // Pass `undefined` for the language argument so Monaco resolves it
    // from the URI's file extension via its registered basic-languages
    // contributions (python, go, rust, yaml, etc. all auto-detected).
    // Unknown extensions fall back to "plaintext", same as before.
    const model =
      monaco.editor.getModel(entry.monacoUri) ??
      monaco.editor.createModel(result.content, undefined, entry.monacoUri);

    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    entry.model = model;
    entry.languageId = model.getLanguageId();
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.lastLoadedValue = result.content;

    attachDirtyTracker({
      cacheUri: entry.cacheUri,
      model,
      loadedMtime: result.mtime,
      loadedSize: result.sizeBytes,
    });

    registerKnownModelUri(entry.cacheUri);
    registerKnownModelUri(entry.lspUri);

    if (isLspLanguage(entry.languageId)) {
      entry.lspOpened = true;
      notifyDidOpen(
        entry.lspUri,
        entry.input.workspaceId,
        entry.languageId,
        entry.version,
        result.content,
      ).catch(() => {});
    }

    entry.contentDisposable = model.onDidChangeContent(() => {
      entry.version += 1;
      if (!entry.lspOpened) return;
      notifyDidChange(entry.lspUri, entry.version, model.getValue()).catch(() => {});
    });

    entry.fsUnsubscribe = subscribeFsChanged(entry.input, () => {
      reconcileExternalChange(entry).catch(() => {});
    });

    notifySubscribers(entry);
  } catch (error) {
    if (entry.disposed) return;
    entry.phase = "error";
    entry.model = null;
    entry.errorCode = errorCodeFromUnknown(error);
    notifySubscribers(entry);
  }
}

async function reconcileExternalChange(entry: ModelEntry): Promise<void> {
  if (entry.disposed) return;

  try {
    const result = await readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      notifySubscribers(entry);
      return;
    }

    const model = entry.model;
    if (!model || model.isDisposed()) return;

    // Stage 5 policy: clean-only external reload. Dirty conflict UI is deferred
    // until save/dirty state exists; for now, guard by the last loaded value.
    if (model.getValue() !== entry.lastLoadedValue) {
      return;
    }

    entry.lastLoadedValue = result.content;
    entry.phase = "ready";
    entry.errorCode = undefined;
    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    // External reload only happens when the buffer was clean
    // (reconcile guard above). The post-setValue alt id becomes the new
    // saved baseline, and on-disk metadata advances to the loaded values.
    markDirtyTrackerSaved({
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

function cleanupEntry(entry: ModelEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  entry.fsUnsubscribe?.();
  entry.contentDisposable?.dispose();
  detachDirtyTracker(entry.cacheUri);
  unregisterKnownModelUri(entry.cacheUri);
  unregisterKnownModelUri(entry.lspUri);

  if (entry.lspOpened) {
    notifyDidClose(entry.lspUri).catch(() => {});
  }

  if (entry.model && !entry.model.isDisposed()) {
    entry.model.dispose();
  }

  entry.subscribers.clear();
}

function cacheUriForInput(input: EditorInput): string {
  return filePathToModelUri(input.filePath);
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

export function isMonacoReady(): boolean {
  return monacoRef !== null;
}

/**
 * Register a callback fired the first time `initializeModelCache` runs.
 * Returns an unsubscribe. Used by the React binding to flip from
 * "loading" to a real acquire once Monaco mounts.
 */
export function onMonacoReady(listener: () => void): () => void {
  initializeListeners.add(listener);
  return () => {
    initializeListeners.delete(listener);
  };
}

export async function acquireModel(input: EditorInput): Promise<SharedModelState> {
  const cacheUri = cacheUriForInput(input);
  let entry = entries.get(cacheUri);
  if (!entry) {
    entry = createEntry(input);
    entries.set(cacheUri, entry);
  }

  entry.refCount += 1;
  await entry.loadPromise;
  return snapshot(entry);
}

export function releaseModel(input: EditorInput): void {
  const cacheUri = cacheUriForInput(input);
  const entry = entries.get(cacheUri);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount > 0) return;

  entries.delete(cacheUri);
  cleanupEntry(entry);
}

/**
 * Read-only view of a resolved model entry. Exposed for the save-service
 * (and similar consumers) so they can act on a tracked model without
 * having to peek at the entry map directly.
 */
export interface ResolvedModelView {
  model: Monaco.editor.ITextModel;
  cacheUri: string;
  workspaceId: string;
  filePath: string;
  languageId: string;
}

export function getResolvedModel(input: EditorInput): ResolvedModelView | null {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry || entry.phase !== "ready" || !entry.model) return null;
  return {
    model: entry.model,
    cacheUri: entry.cacheUri,
    workspaceId: entry.input.workspaceId,
    filePath: entry.input.filePath,
    languageId: entry.languageId,
  };
}
