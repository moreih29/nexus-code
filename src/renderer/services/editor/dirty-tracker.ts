// Per-file dirty tracking, decoupled from model lifecycle and from disk I/O.
//
// Knows nothing about IPC, filesystems, or save mechanics. Owns:
//   1. Listening to a Monaco model's content changes,
//   2. Comparing the model's *alternative* version id (which decreases on
//      undo) against the alt id at the last saved point,
//   3. Notifying subscribers when dirty state flips.
//
// Why alternative version id (and not getValue() string compare): Monaco
// already tracks edit identity via versions; alternativeVersionId is the
// one that walks backwards on undo. If the user types, then undoes back
// to the saved snapshot, the alt id matches the saved id — dirty becomes
// false again. This is O(1) per keystroke; getValue() compare is O(n).
// VSCode's TextFileEditorModel uses the same comparison.

import type * as Monaco from "monaco-editor";

export interface DirtyEntry {
  isDirty: boolean;
  /**
   * The alt versionId of the model at the moment we last considered the
   * buffer "saved" — initially the alt id at attach time, updated when
   * the save-service successfully writes to disk.
   */
  savedAlternativeVersionId: number;
  /**
   * Last on-disk metadata seen by the renderer. The save-service hands
   * these to the writeFile IPC so the main process can detect external
   * modifications since this snapshot.
   */
  loadedMtime: string;
  loadedSize: number;
  contentDisposable: Monaco.IDisposable;
}

const entriesByCacheUri = new Map<string, DirtyEntry>();
const transitionListeners = new Set<DirtyTransitionListener>();
// File-level subscribers exist independently of the entry lifecycle:
// React UI subscribes via useSyncExternalStore *before* the model
// finishes loading (and thus before attachDirtyTracker runs). Storing
// listeners by cacheUri lets us notify on the attach itself, and
// keeps subscriptions valid across detach/reattach.
const fileListeners = new Map<string, Set<() => void>>();
const savedListeners = new Set<(e: { cacheUri: string }) => void>();

export type DirtyTransitionListener = (event: DirtyTransitionEvent) => void;

export interface DirtyTransitionEvent {
  cacheUri: string;
  isDirty: boolean;
}

function notifyFile(cacheUri: string): void {
  const set = fileListeners.get(cacheUri);
  if (!set) return;
  for (const fn of set) fn();
}

function notifyTransition(cacheUri: string, isDirty: boolean): void {
  for (const fn of transitionListeners) fn({ cacheUri, isDirty });
}

function notifySaved(cacheUri: string): void {
  for (const fn of Array.from(savedListeners)) fn({ cacheUri });
}

export interface AttachOptions {
  cacheUri: string;
  model: Monaco.editor.ITextModel;
  loadedMtime: string;
  loadedSize: number;
}

/**
 * Begin tracking dirty state for a model under cacheUri. Creates the
 * entry, hooks model.onDidChangeContent, and seeds saved version to the
 * current alt id. Idempotent: a second attach for the same cacheUri is a
 * no-op (returns the existing entry).
 */
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
    notifyFile(cacheUri);
    notifyTransition(cacheUri, next);
  });

  entriesByCacheUri.set(cacheUri, entry);
  // A subscriber that registered before the entry existed is waiting on
  // exactly this moment — fire so its hook re-reads isDirty (which
  // flipped from "no entry" to "entry, isDirty=false").
  notifyFile(cacheUri);
  return entry;
}

export function detachDirtyTracker(cacheUri: string): void {
  const entry = entriesByCacheUri.get(cacheUri);
  if (!entry) return;
  entry.contentDisposable.dispose();
  entriesByCacheUri.delete(cacheUri);
  // File subscribers persist across detach (e.g. tab still mounted but
  // model unloaded); notify them so they re-read (isDirty becomes false
  // for an absent entry).
  notifyFile(cacheUri);
}

/**
 * Mark the entry's current alt version as the saved baseline. Called by
 * save-service after a successful write. Updates dirty=false and the
 * loaded mtime/size so the next save's stale-write check uses fresh
 * values.
 */
export interface MarkSavedOptions {
  cacheUri: string;
  model: Monaco.editor.ITextModel;
  /** alt versionId captured at the *start* of the save that just succeeded */
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

  // The model may have moved past the saved alt id between save start
  // and save completion (user kept typing). Re-evaluate based on
  // current alt id, not on assumption.
  const next = model.getAlternativeVersionId() !== entry.savedAlternativeVersionId;
  if (next !== entry.isDirty) {
    entry.isDirty = next;
    notifyFile(cacheUri);
    notifyTransition(cacheUri, next);
  }

  notifySaved(cacheUri);
}

/**
 * Update the on-disk metadata (mtime/size) without changing dirty state.
 * Called by model-cache when an external-change reload imports new
 * content the user has not modified — the file on disk has a new
 * mtime/size, and the buffer matches it, so the next save's stale-write
 * guard should compare against these new values.
 */
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

/**
 * Subscribe to dirty state for a specific cacheUri. Stays valid across
 * attach / detach / re-attach cycles (a tab may outlive its model when
 * scrolled out of and back into a leaf, or the model may be reloaded).
 * Notifications fire on transitions only, not on every keystroke.
 */
export function subscribeFile(cacheUri: string, listener: () => void): () => void {
  let set = fileListeners.get(cacheUri);
  if (!set) {
    set = new Set();
    fileListeners.set(cacheUri, set);
  }
  set.add(listener);
  return () => {
    const s = fileListeners.get(cacheUri);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) fileListeners.delete(cacheUri);
  };
}

/**
 * Subscribe to dirty transitions across ALL files. Used by the
 * promote-on-dirty policy and by any process-wide observer (e.g.
 * "do you have unsaved work?" checks).
 */
export function subscribeTransitions(listener: DirtyTransitionListener): () => void {
  transitionListeners.add(listener);
  return () => {
    transitionListeners.delete(listener);
  };
}

/**
 * Subscribe to successful saves across ALL files. Fires once per
 * markSaved call, after dirty state is updated. Use cacheUri to
 * filter to a specific file.
 */
export function subscribeSaved(listener: (e: { cacheUri: string }) => void): () => void {
  savedListeners.add(listener);
  return () => {
    savedListeners.delete(listener);
  };
}

// Test helper: wipe global state between unit tests. Not exported from
// the package barrel; intentionally module-private to consumers.
export function __resetDirtyTrackerForTests(): void {
  for (const entry of entriesByCacheUri.values()) {
    entry.contentDisposable.dispose();
  }
  entriesByCacheUri.clear();
  transitionListeners.clear();
  fileListeners.clear();
  savedListeners.clear();
}
