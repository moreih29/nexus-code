// Monaco singleton — owns the single reference to the monaco-editor namespace
// plus the one-shot "ready" notification channel.
// All other editor modules call requireMonaco() rather than holding their own ref.

import type * as Monaco from "monaco-editor";

let monacoRef: typeof Monaco | null = null;
const initializeListeners = new Set<() => void>();

export function initializeMonacoSingleton(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;
  monacoRef = monaco;
  for (const listener of initializeListeners) {
    listener();
  }
}

export function requireMonaco(): typeof Monaco {
  if (!monacoRef) {
    throw new Error("Monaco is not initialized. Call initializeEditorServices(monaco) first.");
  }
  return monacoRef;
}

export function isMonacoReady(): boolean {
  return monacoRef !== null;
}

/**
 * Register a callback fired the first time `initializeMonacoSingleton` runs.
 * Returns an unsubscribe. Used by the React binding to flip from
 * "loading" to a real acquire once Monaco mounts.
 */
export function onMonacoReady(listener: () => void): () => void {
  initializeListeners.add(listener);
  return () => {
    initializeListeners.delete(listener);
  };
}
