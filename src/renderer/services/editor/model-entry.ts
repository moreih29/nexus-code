// ModelEntry lifecycle — creation, disk load, external-change reconcile, cleanup.
// Owns: model creation, dirty-tracker attachment, LSP open/change/close, fs subscription.

import type * as Monaco from "monaco-editor";
import { type FileErrorCode, parseFileErrorCode } from "../../utils/file-error";
import {
  attachDirtyTracker,
  detachDirtyTracker,
  markSaved as markDirtyTrackerSaved,
} from "./dirty-tracker";
import { ensureModelWithContent } from "./ensure-model";
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

const defaultModelEntryDeps = {
  attachDirtyTracker,
  detachDirtyTracker,
  markDirtyTrackerSaved,
  readFileForModel,
  subscribeFsChanged,
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
  didOpenPromise?: Promise<void>;
  lspDegraded?: boolean;
  disposed: boolean;
  subscribers: Set<() => void>;
  origin: "workspace" | "external";
  readOnly: boolean;
  deps?: ModelEntryDeps;
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

function depsFor(entry: ModelEntry): ModelEntryDeps {
  return entry.deps ?? defaultModelEntryDeps;
}

export function createEntry(
  input: EditorInput,
  cacheUri: string,
  deps: ModelEntryDeps = defaultModelEntryDeps,
): ModelEntry {
  const monaco = deps.requireMonaco();
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
    didOpenPromise: Promise.resolve(),
    lspDegraded: false,
    disposed: false,
    subscribers: new Set(),
    origin,
    readOnly,
    deps,
    originatingWorkspaceId: input.origin === "external" ? input.workspaceId : undefined,
  };

  entry.loadPromise = loadEntry(entry);
  return entry;
}

export async function loadEntry(entry: ModelEntry): Promise<void> {
  const deps = depsFor(entry);
  try {
    const workspaceRoot = deps.workspaceRootForInput(entry.input);
    const result = await deps.readFileForModel(entry.input);
    if (entry.disposed) return;

    if (result.isBinary) {
      entry.phase = "binary";
      entry.model = null;
      notifySubscribers(entry);
      return;
    }

    const monaco = deps.requireMonaco();
    const model = ensureModelWithContent(monaco, entry.monacoUri, result.content);

    entry.model = model;
    entry.languageId = model.getLanguageId();
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.lastLoadedValue = result.content;

    deps.attachDirtyTracker({
      cacheUri: entry.cacheUri,
      model,
      loadedMtime: result.mtime,
      loadedSize: result.sizeBytes,
    });

    deps.registerKnownModelUri(entry.cacheUri);
    deps.registerKnownModelUri(entry.lspUri);

    if (deps.isLspLanguage(entry.languageId)) {
      deps.ensureProvidersFor(model.getLanguageId());
      entry.didOpenPromise = deps
        .notifyDidOpen(
          entry.lspUri,
          entry.input.workspaceId,
          workspaceRoot,
          entry.languageId,
          entry.version,
          result.content,
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

    entry.contentDisposable = model.onDidChangeContent(async (event) => {
      entry.version += 1;
      const version = entry.version;
      const contentChanges = deps.monacoContentChangesToLsp(event.changes);
      if (contentChanges.length === 0) return;
      await entry.didOpenPromise;
      if (!entry.lspOpened || entry.disposed) return;
      deps.notifyDidChange(entry.lspUri, version, contentChanges).catch(() => {
        entry.lspDegraded = true;
      });
    });

    entry.fsUnsubscribe = deps.subscribeFsChanged(entry.input, () => {
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
      return;
    }

    entry.lastLoadedValue = result.content;
    entry.phase = "ready";
    entry.errorCode = undefined;
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

export function cleanupEntry(entry: ModelEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  const deps = depsFor(entry);
  entry.fsUnsubscribe?.();
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
