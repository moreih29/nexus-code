import type * as Monaco from "monaco-editor";
import { create } from "zustand";
import { getEntryMetadata } from "@/services/editor/model";

export interface WorkspaceDiagnostics {
  errorCount: number;
  warningCount: number;
}

export interface DiagnosticsState {
  byWorkspace: Record<string, WorkspaceDiagnostics>;
  _setByWorkspace: (byWorkspace: Record<string, WorkspaceDiagnostics>) => void;
}

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
  byWorkspace: {},
  _setByWorkspace(byWorkspace) {
    set({ byWorkspace });
  },
}));

const EMPTY_DIAGNOSTICS: WorkspaceDiagnostics = { errorCount: 0, warningCount: 0 };

export function selectWorkspaceDiagnostics(
  state: DiagnosticsState,
  workspaceId: string,
): WorkspaceDiagnostics {
  return state.byWorkspace[workspaceId] ?? EMPTY_DIAGNOSTICS;
}

function recount(monaco: typeof Monaco): void {
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

const RECOUNT_DEBOUNCE_MS = 120;

export function initializeDiagnosticsStore(monaco: typeof Monaco): void {
  recount(monaco);
  let timer: ReturnType<typeof setTimeout> | null = null;
  monaco.editor.onDidChangeMarkers(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      recount(monaco);
    }, RECOUNT_DEBOUNCE_MS);
  });
}
