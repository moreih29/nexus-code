/**
 * The view each agent list shows: a default from Settings, and the view
 * each workspace's tab was last switched to, keyed by the workspace its
 * tasks belong to. Both persist in AppState; a workspace's own choice
 * outlasts a later change of the default.
 */

import { create } from "zustand";
import {
  type AgentListView,
  asAgentListView,
  DEFAULT_AGENT_LIST_VIEW,
} from "../../../shared/agent-list/view";
import { createLogger } from "../../../shared/log/renderer";
import type { AppState } from "../../../shared/types/app-state";
import { ipcCallResult } from "../../ipc/client";
import { registerWorkspaceCleanup } from "../workspace-cleanup";

const log = createLogger("agent-list-view");

interface AgentListViewState {
  /** The default from Settings; undefined = DEFAULT_AGENT_LIST_VIEW. */
  defaultView: AgentListView | undefined;
  byWorkspace: Readonly<Record<string, AgentListView>>;
  hydrate(
    state: Partial<Pick<AppState, "agentListViewDefault" | "agentListViewByWorkspace">>,
  ): void;
  setDefault(view: AgentListView | undefined): void;
  setForWorkspace(workspaceId: string, view: AgentListView): void;
}

function persist(patch: Partial<AppState>): void {
  void ipcCallResult("appState", "set", patch).then((result) => {
    if (!result.ok) log.warn(`appState set (sessions view) failed: ${result.message}`);
  });
}

export const useAgentListViewStore = create<AgentListViewState>((set, get) => {
  registerWorkspaceCleanup((id) => {
    if (!(id in get().byWorkspace)) return;
    const { [id]: _removed, ...rest } = get().byWorkspace;
    set({ byWorkspace: rest });
  });

  return {
    defaultView: undefined,
    byWorkspace: {},

    hydrate(state) {
      const byWorkspace: Record<string, AgentListView> = {};
      for (const [id, stored] of Object.entries(state.agentListViewByWorkspace ?? {})) {
        const view = asAgentListView(stored);
        if (view) byWorkspace[id] = view;
      }
      set({ defaultView: asAgentListView(state.agentListViewDefault), byWorkspace });
    },

    setDefault(view) {
      set({ defaultView: view });
      persist({ agentListViewDefault: view });
    },

    setForWorkspace(workspaceId, view) {
      if (get().byWorkspace[workspaceId] === view) return;
      const byWorkspace = { ...get().byWorkspace, [workspaceId]: view };
      set({ byWorkspace });
      persist({ agentListViewByWorkspace: byWorkspace });
    },
  };
});

/** The view a workspace's agent list shows. */
export function selectAgentListView(state: AgentListViewState, workspaceId: string): AgentListView {
  return state.byWorkspace[workspaceId] ?? state.defaultView ?? DEFAULT_AGENT_LIST_VIEW;
}
