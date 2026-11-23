import { absolutePathToFileUri } from "../../../../shared/fs/file-uri";
import { isLspEnabledForWorkspace } from "../../../state/stores/lsp-settings";
import { type FileErrorCode, parseFileErrorCode } from "../../../utils/file-error";
import type { TextEncoding } from "../encoding/text-encoding";
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
  type FileLoadResult,
  readFileForModel,
  setEncodingOverride,
  statFileForModel,
  subscribeFsChanged,
  subscribeGitStatusChanged,
  workspaceRootForInput,
} from "./file-loader";
import { readAndPlaceContent } from "./read-and-place-content";
import type { ModelEntry, ModelEntryDeps, SharedModelState } from "./types";

export type { ModelEntry, ModelEntryDeps, SharedModelPhase, SharedModelState } from "./types";

const defaultModelEntryDeps: ModelEntryDeps = {
  attachDirtyTracker,
  detachDirtyTracker,
  markDirtyTrackerSaved,
  readFileForModel,
  statFileForModel,
  getDirtyEntry,
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

export function errorCodeFromUnknown(error: unknown): FileErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  return parseFileErrorCode(message);
}

export function snapshot(entry: ModelEntry): SharedModelState {
  return {
    phase: entry.phase,
    model: entry.phase === "ready" ? entry.model : null,
    errorCode: entry.errorCode,
    readOnly: entry.readOnly,
    diskDiverged: entry.diskDiverged,
  };
}

export function notifySubscribers(entry: ModelEntry): void {
  for (const subscriber of entry.subscribers) {
    subscriber();
  }
}

function depsFor(entry: ModelEntry): ModelEntryDeps {
  return entry.deps ?? defaultModelEntryDeps;
}

export function rehydrateEntry(entry: ModelEntry): Promise<void> {
  return rehydrateEntryLspOpened(entry, depsFor(entry));
}

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

  deps.attachDirtyTracker({
    cacheUri,
    model,
    loadedMtime: "",
    loadedSize: 0,
  });

  deps.registerKnownModelUri(cacheUri);

  return entry;
}

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
    entry.lastLoadedValue = placed.model.getValue();
    entry.encoding = placed.encoding;

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

    if (entry.origin === "workspace") {
      entry.gitUnsubscribe = deps.attachGitSubscription(entry, deps, () => {
        reconcileIfStatChanged(entry).catch(() => {});
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

export async function reconcileExternalChange(entry: ModelEntry): Promise<void> {
  if (entry.disposed) return;
  const deps = depsFor(entry);
  const hasUnsavedEdits = (): boolean => {
    const model = entry.model;
    return model !== null && !model.isDisposed() && model.getValue() !== entry.lastLoadedValue;
  };

  const seq = (entry.diskReadSeq ?? 0) + 1;
  entry.diskReadSeq = seq;

  try {
    const result = await deps.readFileForModel(entry.input);
    if (entry.disposed) return;
    if (entry.diskReadSeq !== seq) return;

    if (hasUnsavedEdits()) {
      entry.phase = "ready";
      entry.errorCode = undefined;
      entry.diskDiverged = { mtime: result.mtime, size: result.sizeBytes };
      notifySubscribers(entry);
      return;
    }

    if (result.isBinary) {
      entry.phase = "binary";
      notifySubscribers(entry);
      return;
    }

    const model = entry.model;
    if (!model || model.isDisposed()) return;

    applyDiskText(entry, model, result);
  } catch (error) {
    if (entry.disposed || entry.diskReadSeq !== seq) return;
    if (hasUnsavedEdits()) return;
    entry.phase = "error";
    entry.errorCode = errorCodeFromUnknown(error);
    notifySubscribers(entry);
  }
}

export async function reconcileIfStatChanged(entry: ModelEntry): Promise<void> {
  if (entry.disposed) return;
  const deps = depsFor(entry);
  try {
    const loaded = deps.getDirtyEntry(entry.cacheUri);
    if (loaded && entry.phase === "ready") {
      const stat = await deps.statFileForModel(entry.input);
      if (entry.disposed) return;
      if (stat.mtime === loaded.loadedMtime && stat.size === loaded.loadedSize) return;
    }
  } catch {}
  await reconcileExternalChange(entry);
}

export async function reloadEntryFromDisk(
  entry: ModelEntry,
  encoding?: TextEncoding,
  onReadFailure?: (error: unknown) => void,
): Promise<boolean> {
  if (entry.disposed) return false;
  const deps = depsFor(entry);
  if (encoding !== undefined && deps.getDirtyEntry(entry.cacheUri)?.isDirty) return false;

  const seq = (entry.diskReadSeq ?? 0) + 1;
  entry.diskReadSeq = seq;
  const model = entry.model;
  const version = model?.getVersionId();
  const isCurrent = () =>
    !entry.disposed &&
    entry.diskReadSeq === seq &&
    entry.model === model &&
    (!model || (!model.isDisposed() && model.getVersionId() === version));

  try {
    const result = await deps.readFileForModel(entry.input, encoding);
    if (!isCurrent()) return false;

    if (result.isBinary) {
      entry.phase = "binary";
      entry.diskDiverged = undefined;
      notifySubscribers(entry);
      return true;
    }

    if (!model) return false;

    applyDiskText(entry, model, result, encoding);
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    if (!deps.getDirtyEntry(entry.cacheUri)?.isDirty) {
      entry.phase = "error";
      entry.errorCode = errorCodeFromUnknown(error);
      notifySubscribers(entry);
    }
    onReadFailure?.(error);
    return false;
  }
}

function applyDiskText(
  entry: ModelEntry,
  model: NonNullable<ModelEntry["model"]>,
  result: FileLoadResult,
  encodingOverride?: TextEncoding,
): void {
  entry.encoding = result.encoding;
  entry.phase = "ready";
  entry.errorCode = undefined;
  entry.diskDiverged = undefined;
  if (model.getValue() !== result.content) {
    model.setValue(result.content);
  }
  entry.lastLoadedValue = model.getValue();
  if (encodingOverride !== undefined) setEncodingOverride(entry.input, encodingOverride);

  depsFor(entry).markDirtyTrackerSaved({
    cacheUri: entry.cacheUri,
    model,
    savedAlternativeVersionId: model.getAlternativeVersionId(),
    loadedMtime: result.mtime,
    loadedSize: result.sizeBytes,
  });
  notifySubscribers(entry);
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
