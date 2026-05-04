// Monaco TextModel reference counting.
// Mirrors VSCode ITextModelService — models are owned by the cache, not by editor instances.
// Public surface: useSharedModel(uri) hook + acquire/release primitives.

import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";
import { type FileErrorCode, parseFileErrorCode } from "../../utils/file-error";
import { readFileForModel, subscribeFsChanged } from "./file-loader";
import {
  isLspLanguage,
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

export function languageIdForPath(filePath: string): string {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  const extension = basename.includes(".")
    ? basename.slice(basename.lastIndexOf(".")).toLowerCase()
    : "";

  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".json":
      return "json";
    case ".css":
      return "css";
    case ".html":
    case ".htm":
      return "html";
    case ".md":
    case ".markdown":
      return "markdown";
    default:
      return "plaintext";
  }
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
  const languageId = languageIdForPath(input.filePath);
  const entry: ModelEntry = {
    input,
    cacheUri,
    lspUri: monacoUri.toString(),
    monacoUri,
    languageId,
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
    const model =
      monaco.editor.getModel(entry.monacoUri) ??
      monaco.editor.createModel(result.content, entry.languageId, entry.monacoUri);

    if (model.getValue() !== result.content) {
      model.setValue(result.content);
    }

    entry.model = model;
    entry.phase = "ready";
    entry.errorCode = undefined;
    entry.lastLoadedValue = result.content;

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

function subscribeEntry(input: EditorInput, onChange: () => void): () => void {
  const entry = entries.get(cacheUriForInput(input));
  if (!entry) return () => {};
  entry.subscribers.add(onChange);
  return () => {
    entry.subscribers.delete(onChange);
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

export function useSharedModel(input: EditorInput): SharedModelState {
  const { workspaceId, filePath } = input;
  const [state, setState] = useState<SharedModelState>({
    phase: "loading",
    model: null,
  });
  const [isMonacoReady, setIsMonacoReady] = useState(monacoRef !== null);

  useEffect(() => {
    if (monacoRef) return;
    const listener = () => setIsMonacoReady(true);
    initializeListeners.add(listener);
    return () => {
      initializeListeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let acquired = false;
    let unsubscribe = () => {};
    const sharedInput = { workspaceId, filePath };

    if (!isMonacoReady || !monacoRef) {
      setState({ phase: "loading", model: null });
      return () => {
        cancelled = true;
      };
    }

    setState({ phase: "loading", model: null });

    acquireModel(sharedInput)
      .then((nextState) => {
        acquired = true;
        if (cancelled) {
          releaseModel(sharedInput);
          return;
        }

        setState(nextState);
        unsubscribe = subscribeEntry(sharedInput, () => {
          const entry = entries.get(cacheUriForInput(sharedInput));
          if (entry) setState(snapshot(entry));
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState({ phase: "error", model: null, errorCode: errorCodeFromUnknown(error) });
      });

    return () => {
      cancelled = true;
      unsubscribe();
      if (acquired) {
        releaseModel(sharedInput);
      }
    };
  }, [workspaceId, filePath, isMonacoReady]);

  return state;
}
