import type * as Monaco from "monaco-editor";
import { createKeyedListenerBus, createListenerBus } from "../../../../shared/util/listener-bus";

export interface DirtyEntry {
  isDirty: boolean;
  savedAlternativeVersionId: number;
  loadedMtime: string;
  loadedSize: number;
  contentDisposable: Monaco.IDisposable;
}

const entriesByCacheUri = new Map<string, DirtyEntry>();
const fileListeners = createKeyedListenerBus<string, void>();
const transitionListeners = createListenerBus<DirtyTransitionEvent>();
const savedListeners = createListenerBus<{ cacheUri: string }>();

export type DirtyTransitionListener = (event: DirtyTransitionEvent) => void;

export interface DirtyTransitionEvent {
  cacheUri: string;
  isDirty: boolean;
}

export interface AttachOptions {
  cacheUri: string;
  model: Monaco.editor.ITextModel;
  loadedMtime: string;
  loadedSize: number;
}

export function attachDirtyTracker({
  cacheUri,
  model,
  loadedMtime,
  loadedSize,
}: AttachOptions): DirtyEntry {
  const existing = entriesByCacheUri.get(cacheUri);
  if (existing) return existing;

  const entry: DirtyEntry = {
    isDirty: false,
    savedAlternativeVersionId: model.getAlternativeVersionId(),
    loadedMtime,
    loadedSize,
    contentDisposable: { dispose: () => {} },
  };

  entry.contentDisposable = model.onDidChangeContent(() => {
    const next = model.getAlternativeVersionId() !== entry.savedAlternativeVersionId;
    if (next === entry.isDirty) return;
    entry.isDirty = next;
    fileListeners.notify(cacheUri, undefined);
    transitionListeners.notify({ cacheUri, isDirty: next });
  });

  entriesByCacheUri.set(cacheUri, entry);
  fileListeners.notify(cacheUri, undefined);
  return entry;
}

export function detachDirtyTracker(cacheUri: string): void {
  const entry = entriesByCacheUri.get(cacheUri);
  if (!entry) return;
  entry.contentDisposable.dispose();
  entriesByCacheUri.delete(cacheUri);
  fileListeners.notify(cacheUri, undefined);
}

export interface MarkSavedOptions {
  cacheUri: string;
  model: Monaco.editor.ITextModel;
  savedAlternativeVersionId: number;
  loadedMtime: string;
  loadedSize: number;
}

export function markSaved({
  cacheUri,
  model,
  savedAlternativeVersionId,
  loadedMtime,
  loadedSize,
}: MarkSavedOptions): void {
  const entry = entriesByCacheUri.get(cacheUri);
  if (!entry) return;

  entry.savedAlternativeVersionId = savedAlternativeVersionId;
  entry.loadedMtime = loadedMtime;
  entry.loadedSize = loadedSize;

  const next = model.getAlternativeVersionId() !== entry.savedAlternativeVersionId;
  if (next !== entry.isDirty) {
    entry.isDirty = next;
    fileListeners.notify(cacheUri, undefined);
    transitionListeners.notify({ cacheUri, isDirty: next });
  }

  savedListeners.notify({ cacheUri });
}

export function updateLoadedMetadata(cacheUri: string, mtime: string, size: number): void {
  const entry = entriesByCacheUri.get(cacheUri);
  if (!entry) return;
  entry.loadedMtime = mtime;
  entry.loadedSize = size;
}

export function getDirtyEntry(cacheUri: string): DirtyEntry | undefined {
  return entriesByCacheUri.get(cacheUri);
}

export function isDirty(cacheUri: string): boolean {
  return entriesByCacheUri.get(cacheUri)?.isDirty ?? false;
}

export function listDirtyCacheUris(): string[] {
  const dirty: string[] = [];
  for (const [cacheUri, entry] of entriesByCacheUri) {
    if (entry.isDirty) dirty.push(cacheUri);
  }
  return dirty;
}

export function subscribeFileDirty(cacheUri: string, listener: () => void): () => void {
  return fileListeners.subscribe(cacheUri, () => listener());
}

export function subscribeAllDirtyTransitions(listener: DirtyTransitionListener): () => void {
  return transitionListeners.subscribe(listener);
}

export function subscribeAllSaved(listener: (e: { cacheUri: string }) => void): () => void {
  return savedListeners.subscribe(listener);
}

export function __resetDirtyTrackerForTests(): void {
  for (const entry of entriesByCacheUri.values()) {
    entry.contentDisposable.dispose();
  }
  entriesByCacheUri.clear();
  transitionListeners.clear();
  fileListeners.clear();
  savedListeners.clear();
}
