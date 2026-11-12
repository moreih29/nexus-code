/**
 * What the nexus CLI reads and changes of the agent view: whether the
 * window shows it, and its panels and the sessions each holds.
 *
 * As with ./actions, nothing here takes keyboard focus, except for showing
 * a view or a panel, which is what the command asks for.
 */

import { Grid } from "@/engine";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { useTabsStore } from "@/state/stores/tabs";
import type { CliUiOp, CliViewAgent } from "../../../shared/cli/ui";
import { sessionKey } from "../agent-sessions/model";
import {
  type AgentLayout,
  closeLeaf,
  heldKeys,
  openKey,
  parseSessionKey,
  placeKey,
  removeKey,
  setActiveLeaf,
  setRatio,
} from "../agent-view/layout";
import {
  focusActiveAgent,
  holdsInAgentView,
  switchView,
  updateKeepingActive,
  updateKeepingFocus,
} from "../agent-view/show";
import { type CliUiHandler, tabRecord, UiRequestError } from "./actions";
import { toCli } from "./layout-actions";

type ViewOp = Extract<CliUiOp, `agentView.${string}`>;

function agentsHeld(): CliViewAgent[] {
  const tabs = useTabsStore.getState().byWorkspace;
  return heldKeys(useAgentViewStore.getState().root).flatMap((key) => {
    const session = parseSessionKey(key);
    const tab = session ? tabs[session.workspaceId]?.[session.tabId] : undefined;
    if (!session || !tab) return [];
    return [{ key, ...session, title: tab.title, type: tab.type }];
  });
}

function panelOf(panelId: string) {
  const leaf = Grid.findLeaf(useAgentViewStore.getState().root, panelId);
  if (!leaf) throw new UiRequestError("that panel is gone");
  return leaf;
}

export const viewHandlers: { [K in ViewOp]: CliUiHandler<K> } = {
  "agentView.get": async () => {
    const { mode, root, activeLeafId } = useAgentViewStore.getState();
    return {
      view: mode === "agents" ? "agents" : "workspaces",
      root: toCli(root),
      activePanelId: activeLeafId,
      agents: agentsHeld(),
    };
  },

  "agentView.show": async ({ view }) => {
    switchView(view === "agents" ? "agents" : "workspace");
    return {};
  },

  "agentView.place": async ({ workspaceId, tabId, panelId, side, index, show }) => {
    const tab = tabRecord(workspaceId, tabId);
    if (!holdsInAgentView(tab.type)) {
      throw new UiRequestError(
        "the agent view shows Claude and Codex tabs and terminals, not that tab",
      );
    }
    if (panelId !== undefined) panelOf(panelId);
    // Its workspace runs its tabs once mounted.
    useMountedWorkspacesStore.getState().mount(workspaceId);
    const key = sessionKey(workspaceId, tabId);
    const change = (layout: AgentLayout) =>
      panelId === undefined ? openKey(layout, key) : placeKey(layout, key, panelId, side, index);
    if (show) {
      updateKeepingFocus(change);
      switchView("agents");
    } else {
      updateKeepingActive(change);
    }
    const holder = Grid.findLeafByTab(useAgentViewStore.getState().root, (id) => id === key);
    if (!holder) throw new UiRequestError("the session did not go into the agent view");
    return { panelId: holder.leaf.id };
  },

  "agentView.remove": async ({ workspaceId, tabId }) => {
    updateKeepingActive((layout) => removeKey(layout, sessionKey(workspaceId, tabId)));
    return {};
  },

  "agentView.close": async ({ panelId }) => {
    const removed = panelOf(panelId).tabIds.length;
    updateKeepingFocus((layout) => closeLeaf(layout, panelId));
    return { removed };
  },

  "agentView.ratios": async ({ ratios }) => {
    useAgentViewStore
      .getState()
      .update((layout) =>
        ratios.reduce((next, { splitId, ratio }) => setRatio(next, splitId, ratio), layout),
      );
    return {};
  },

  "agentView.focus": async ({ panelId }) => {
    panelOf(panelId);
    const store = useAgentViewStore.getState();
    store.update((layout) => setActiveLeaf(layout, panelId));
    if (store.mode === "agents") focusActiveAgent();
    return {};
  },
};
