// Monaco singleton — owns the single reference to the monaco-editor namespace
// plus the one-shot "ready" notification channel.
// All other editor modules call requireMonaco() rather than holding their own ref.

import type * as Monaco from "monaco-editor";
import { createListenerBus } from "../../../shared/listener-bus";

let monacoRef: typeof Monaco | null = null;
const bus = createListenerBus();

export function initializeMonacoSingleton(monaco: typeof Monaco): void {
  if (monacoRef === monaco) return;
  monacoRef = monaco;
  bus.notify();
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
  return bus.subscribe(listener);
}
