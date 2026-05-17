// diagnostics.ts — Monaco marker per-workspace store.
//
// Subscribes to monaco.editor.onDidChangeMarkers (fired whenever any model's
// markers change) and maintains per-workspace error/warning counts. Each
// marker is attributed to a workspace by resolving its URI through
// getEntryMetadata — markers for URIs not present in the model cache are
// skipped.
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
import { getEntryMetadata } from "@/services/editor/model";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface WorkspaceDiagnostics {
  errorCount: number;
  warningCount: number;
}

export interface DiagnosticsState {
  /** Per-workspace error/warning counts keyed by workspaceId. */
  byWorkspace: Record<string, WorkspaceDiagnostics>;
  /** Internal setter — only called by the Monaco subscription. */
  _setByWorkspace: (byWorkspace: Record<string, WorkspaceDiagnostics>) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  byWorkspace: {},
  _setByWorkspace(byWorkspace) {
    set({ byWorkspace });
  },
}));

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Stable empty result. Returned by reference (never a fresh object) so the
 * selector's snapshot is referentially stable across renders — required by
 * useSyncExternalStore to avoid an infinite render loop.
 */
const EMPTY_DIAGNOSTICS: WorkspaceDiagnostics = { errorCount: 0, warningCount: 0 };

/**
 * Select error/warning counts for a specific workspace.
 * Returns a shared zero-count object when no diagnostics are recorded for
 * that workspace.
 */
export function selectWorkspaceDiagnostics(
  state: DiagnosticsState,
  workspaceId: string,
): WorkspaceDiagnostics {
  return state.byWorkspace[workspaceId] ?? EMPTY_DIAGNOSTICS;
}

// ---------------------------------------------------------------------------
// Initialization — attach the Monaco marker subscription.
//
// Called once from initializeEditorServices(monaco) after Monaco is ready.
// The IDisposable returned by onDidChangeMarkers is intentionally not stored
// for cleanup — the subscription lives for the entire app lifetime.
// ---------------------------------------------------------------------------

/**
 * Recount error/warning markers per workspace and update the store.
 * Called (trailing-debounced) after marker changes.
 */
function recount(monaco: typeof Monaco): void {
  // monaco.editor.getModelMarkers({}) returns all markers for all owners/URIs.
  // Filtering to Error and Warning severity satisfies the spec; Info and Hint
  // are not surfaced in the status bar.
  const all = monaco.editor.getModelMarkers({});
  const tally: Record<string, WorkspaceDiagnostics> = {};
  for (const marker of all) {
    if (
      marker.severity !== monaco.MarkerSeverity.Error &&
      marker.severity !== monaco.MarkerSeverity.Warning
    ) {
      continue;
    }
    const meta = getEntryMetadata(marker.resource.toString());
    if (!meta) continue;
    const bucket = tally[meta.workspaceId] ?? { errorCount: 0, warningCount: 0 };
    if (marker.severity === monaco.MarkerSeverity.Error) {
      bucket.errorCount += 1;
    } else {
      bucket.warningCount += 1;
    }
    tally[meta.workspaceId] = bucket;
  }

  // Identity preservation: reuse the prior object for any workspace whose
  // counts are unchanged, and skip the store update entirely when nothing
  // changed. This stops a marker event in workspace A from re-rendering the
  // StatusBars of every other mounted workspace (each panel stays mounted).
  const prev = useDiagnosticsStore.getState().byWorkspace;
  let changed = Object.keys(prev).length !== Object.keys(tally).length;
  for (const [workspaceId, next] of Object.entries(tally)) {
    const before = prev[workspaceId];
    if (
      before &&
      before.errorCount === next.errorCount &&
      before.warningCount === next.warningCount
    ) {
      tally[workspaceId] = before;
    } else {
      changed = true;
    }
  }
  if (!changed) return;
  useDiagnosticsStore.getState()._setByWorkspace(tally);
}

/**
 * Trailing-debounce window for marker recounts. onDidChangeMarkers can fire
 * many times per second while an LSP streams diagnostics during typing; the
 * status-bar counts do not need sub-frame freshness.
 */
const RECOUNT_DEBOUNCE_MS = 120;

/**
 * Wire Monaco's marker change subscription to the diagnostics store.
 * Must be called after `initializeMonacoSingleton` (i.e. inside
 * `initializeEditorServices`).
 */
export function initializeDiagnosticsStore(monaco: typeof Monaco): void {
  // Recount immediately in case markers exist before subscription.
  recount(monaco);
  // onDidChangeMarkers fires with a list of changed URIs — we ignore them and
  // always do a full recount. A trailing debounce coalesces the burst of
  // events an LSP emits while the user types into a single recount.
  let timer: ReturnType<typeof setTimeout> | null = null;
  monaco.editor.onDidChangeMarkers(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      recount(monaco);
    }, RECOUNT_DEBOUNCE_MS);
  });
}
