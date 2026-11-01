/**
 * The view each sessions tab shows: a default from Settings, and the view
 * each workspace's tab was last switched to, keyed by the workspace its
 * tasks belong to. Both persist in AppState; a workspace's own choice
 * outlasts a later change of the default.
 */

import { create } from "zustand";
import { createLogger } from "../../../shared/log/renderer";
import {
  asSessionsView,
  DEFAULT_SESSIONS_VIEW,
  type SessionsView,
} from "../../../shared/sessions/view";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

const log = createLogger("sessions-view");

interface SessionsViewState {
  /** The default from Settings; undefined = DEFAULT_SESSIONS_VIEW. */
  defaultView: SessionsView | undefined;
  byWorkspace: Readonly<Record<string, SessionsView>>;
  hydrate(state: Partial<Pick<AppState, "sessionsViewDefault" | "sessionsViewByWorkspace">>): void;
  setDefault(view: SessionsView | undefined): void;
  setForWorkspace(workspaceId: string, view: SessionsView): void;
}

function persist(patch: Partial<AppState>): void {
  void ipcCallResult("appState", "set", patch).then((result) => {
    if (!result.ok) log.warn(`appState set (sessions view) failed: ${result.message}`);
  });
}

export const useSessionsViewStore = create<SessionsViewState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    if (!(id in get().byWorkspace)) return;
    const { [id]: _removed, ...rest } = get().byWorkspace;
    set({ byWorkspace: rest });
  });

  return {
    defaultView: undefined,
    byWorkspace: {},

    hydrate(state) {
      const byWorkspace: Record<string, SessionsView> = {};
      for (const [id, stored] of Object.entries(state.sessionsViewByWorkspace ?? {})) {
        const view = asSessionsView(stored);
        if (view) byWorkspace[id] = view;
      }
      set({ defaultView: asSessionsView(state.sessionsViewDefault), byWorkspace });
    },

    setDefault(view) {
      set({ defaultView: view });
      persist({ sessionsViewDefault: view });
    },

    setForWorkspace(workspaceId, view) {
      if (get().byWorkspace[workspaceId] === view) return;
      const byWorkspace = { ...get().byWorkspace, [workspaceId]: view };
      set({ byWorkspace });
      persist({ sessionsViewByWorkspace: byWorkspace });
    },
  };
});

/** The view a workspace's sessions tab shows. */
export function selectSessionsView(state: SessionsViewState, workspaceId: string): SessionsView {
  return state.byWorkspace[workspaceId] ?? state.defaultView ?? DEFAULT_SESSIONS_VIEW;
}
