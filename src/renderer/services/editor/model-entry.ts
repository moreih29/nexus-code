// ModelEntry lifecycle — creation, disk load, external-change reconcile, cleanup.
// Owns: model creation, dirty-tracker attachment, LSP open/change/close, fs subscription.

import type * as Monaco from "monaco-editor";
import { type FileErrorCode, parseFileErrorCode } from "../../utils/file-error";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  markSaved as markDirtyTrackerSaved,
} from "./dirty-tracker";
import { readFileForModel, subscribeFsChanged, workspaceRootForInput } from "./file-loader";
import { isLspLanguage } from "./language";
import {
  ensureProvidersFor,
  monacoContentChangesToLsp,
  notifyDidChange,
  notifyDidClose,
  notifyDidOpen,
  registerKnownModelUri,
  unregisterKnownModelUri,
} from "./lsp-bridge";
import { requireMonaco } from "./monaco-singleton";
import type { EditorInput } from "./types";

export type SharedModelPhase = "loading" | "ready" | "binary" | "error";

export interface SharedModelState {
  phase: SharedModelPhase;
  model: Monaco.editor.ITextModel | null;
  errorCode?: FileErrorCode;
  readOnly: boolean;
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
  lspOpened: boolean;
  disposed: boolean;
  subscribers: Set<() => void>;
  origin: "workspace" | "external";
  readOnly: boolean;
  /** Set only when origin === "external"; identifies the workspace the opener came from. */
  originatingWorkspaceId?: string;
}

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
  };
}

export function notifySubscribers(entry: ModelEntry): void {
  for (const subscriber of entry.subscribers) {
    subscriber();
  }
}

export function createEntry(input: EditorInput, cacheUri: string): ModelEntry {
  const monaco = requireMonaco();
  const monacoUri = monaco.Uri.parse(cacheUri);
  const origin: "workspace" | "external" = input.origin ?? "workspace";
  const readOnly: boolean = input.readOnly ?? false;
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
    origin,
    readOnly,
    originatingWorkspaceId: input.origin === "external" ? input.workspaceId : undefined,
  };

  entry.loadPromise = loadEntry(entry);
  return entry;
}

export async function loadEntry(entry: ModelEntry): Promise<void> {
  try {
    const workspaceRoot = workspaceRootForInput(entry.input);
    const result = await readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      entry.model = null;
      notifySubscribers(entry);
      return;
    }

    const monaco = requireMonaco();
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
      ensureProvidersFor(model.getLanguageId());
      entry.lspOpened = true;
      notifyDidOpen(
        entry.lspUri,
        entry.input.workspaceId,
        workspaceRoot,
        entry.languageId,
        entry.version,
        result.content,
      ).catch(() => {});
    }

    entry.contentDisposable = model.onDidChangeContent((event) => {
      entry.version += 1;
      if (!entry.lspOpened) return;
      const contentChanges = monacoContentChangesToLsp(event.changes);
      if (contentChanges.length === 0) return;
      notifyDidChange(entry.lspUri, entry.version, contentChanges).catch(() => {});
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

export async function reconcileExternalChange(entry: ModelEntry): Promise<void> {
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

    if (model.getValue() !== entry.lastLoadedValue) {
      return;
    }

    entry.lastLoadedValue = result.content;
    entry.phase = "ready";
    entry.errorCode = undefined;
    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

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

export function cleanupEntry(entry: ModelEntry): void {
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
