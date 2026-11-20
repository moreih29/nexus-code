/**
 * What the nexus CLI reads and changes of the agent view: whether the
 * window shows it, and its panels and the tabs each holds.
 *
 * As with ./actions, nothing here takes keyboard focus, except for showing
 * a view or a panel, which is what the command asks for.
 */

import { Grid } from "@/engine";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { type RemoteTarget, useRemoteViewStore } from "@/state/stores/remote-view";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { basename } from "@/utils/path";
import type { CliAgentView, CliUiOp, CliViewAgent, CliViewHeldTab } from "../../../shared/cli/ui";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import type { RemoteFileSnapshot } from "../../../shared/types/agent-view";
import { sessionKey } from "../agent-sessions/model";
import {
  type AgentLayout,
  closeLeaf,
  heldKeys,
  openKey,
  parseRemoteSessionKey,
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

function describeTabs(
  keys: readonly string[],
  tabs: Record<string, Record<string, Tab>>,
  remoteFiles: ReadonlyMap<string, RemoteFileSnapshot>,
  remoteTargets: ReadonlyMap<string, RemoteTarget>,
): Pick<CliAgentView, "agents" | "held"> {
  const agents: CliViewAgent[] = [];
  const held: CliViewHeldTab[] = [];
  for (const key of keys) {
    const session = parseSessionKey(key);
    if (session) {
      const tab = tabs[session.workspaceId]?.[session.tabId];
      if (tab?.type === "editor") {
        const path = tab.props.filePath;
        held.push({
          key,
          kind: "file",
          workspaceId: session.workspaceId,
          title: basename(path),
          path,
        });
      } else if (tab && holdsInAgentView(tab.type)) {
        agents.push({ key, ...session, title: tab.title, type: tab.type });
      }
      continue;
    }

    const file = parseRemoteFileKey(key);
    if (file) {
      held.push({
        key,
        kind: "remote-file",
        workspaceId: file.workspaceId,
        title: basename(toSlashPath(file.path)),
        device: remoteFiles.get(key)?.deviceName || file.deviceId.slice(0, 8),
        path: file.path,
      });
      continue;
    }

    const remote = parseRemoteSessionKey(key);
    if (remote) {
      const target = remoteTargets.get(key);
      held.push({
        key,
        kind: "remote-session",
        workspaceId: remote.workspaceId,
        title: target?.title || remote.tabId.slice(0, 8),
        device: target?.deviceName || remote.deviceId.slice(0, 8),
        ...(target?.path ? { path: target.path } : {}),
      });
    }
  }
  return { agents, held };
}

function panelOf(panelId: string) {
  const leaf = Grid.findLeaf(useAgentViewStore.getState().root, panelId);
  if (!leaf) throw new UiRequestError("that panel is gone");
  return leaf;
}

export const viewHandlers: { [K in ViewOp]: CliUiHandler<K> } = {
  "agentView.get": async () => {
    const { mode, root, activeLeafId, grouping, remoteFiles } = useAgentViewStore.getState();
    return {
      view: mode === "agents" ? "agents" : "workspaces",
      grouping,
      root: toCli(root),
      activePanelId: activeLeafId,
      ...describeTabs(
        heldKeys(root),
        useTabsStore.getState().byWorkspace,
        remoteFiles,
        useRemoteViewStore.getState().targets,
      ),
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

  "agentView.group": async ({ grouping }) => {
    useAgentViewStore.getState().setGrouping(grouping);
    return {};
  },
};
