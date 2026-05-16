// diagnostics.ts — Monaco marker aggregate store.
//
// Subscribes to monaco.editor.onDidChangeMarkers (fired whenever any model's
// markers change) and maintains a process-wide aggregate of error and warning
// counts across ALL open models.
//
// Initialization: call initializeDiagnosticsStore(monaco) once inside
// initializeEditorServices(). The subscription is process-scoped — it is not
// per-workspace and is never torn down (app lifetime).
//
// Leak safety: onDidChangeMarkers only fires for live URIs, and
// monaco.editor.getModelMarkers returns an empty array for a disposed model's
// URI. We recount from all marker owner data on each change event — we never
// hold model references ourselves.

import type * as Monaco from "monaco-editor";
import { create } from "zustand";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface DiagnosticsState {
  /** Total error-severity marker count across all open models. */
  errorCount: number;
  /** Total warning-severity marker count across all open models. */
  warningCount: number;
  /** Internal setter — only called by the Monaco subscription. */
  _setCount: (errorCount: number, warningCount: number) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  errorCount: 0,
  warningCount: 0,
  _setCount(errorCount, warningCount) {
    set({ errorCount, warningCount });
  },
}));

// ---------------------------------------------------------------------------
// Initialization — attach the Monaco marker subscription.
//
// Called once from initializeEditorServices(monaco) after Monaco is ready.
// The IDisposable returned by onDidChangeMarkers is intentionally not stored
// for cleanup — the subscription lives for the entire app lifetime.
// ---------------------------------------------------------------------------

/**
 * Recount error/warning markers across all models and update the store.
 * Called on every onDidChangeMarkers event.
 */
function recount(monaco: typeof Monaco): void {
  // monaco.editor.getModelMarkers({}) returns all markers for all owners/URIs.
  // Filtering to Error and Warning severity satisfies the spec; Info and Hint
  // are not surfaced in the status bar.
  const all = monaco.editor.getModelMarkers({});
  let errors = 0;
  let warnings = 0;
  for (const marker of all) {
    if (marker.severity === monaco.MarkerSeverity.Error) {
      errors += 1;
    } else if (marker.severity === monaco.MarkerSeverity.Warning) {
      warnings += 1;
    }
  }
  useDiagnosticsStore.getState()._setCount(errors, warnings);
}

/**
 * Wire Monaco's marker change subscription to the diagnostics store.
 * Must be called after `initializeMonacoSingleton` (i.e. inside
 * `initializeEditorServices`).
 */
export function initializeDiagnosticsStore(monaco: typeof Monaco): void {
  // Recount immediately in case markers exist before subscription.
  recount(monaco);
  // onDidChangeMarkers fires with a list of changed URIs — we ignore them
  // and always do a full recount (simpler, no URI-level bookkeeping needed).
  monaco.editor.onDidChangeMarkers(() => {
    recount(monaco);
  });
}
