import { Grid } from "@/engine";
import { useAgentViewStore } from "@/state/stores/agent-view";
import { useMountedWorkspacesStore } from "@/state/stores/mounted-workspaces";
import { type RemoteTarget, useRemoteViewStore } from "@/state/stores/remote-view";
import { type Tab, useTabsStore } from "@/state/stores/tabs";
import { basename } from "@/utils/path";
import type {
  CliAgentView,
  CliSplitSide,
  CliUiOp,
  CliViewAgent,
  CliViewHeldTab,
} from "../../../shared/cli/ui";
import { toSlashPath } from "../../../shared/fs/drive-path";
import { parseRemoteFileKey } from "../../../shared/fs/remote-file-key";
import type { RemoteFileSnapshot } from "../../../shared/types/agent-view";
import { shortId } from "../../../shared/util/short-id";
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
import { reorderSidebarSessions } from "../agent-view/session-order";
import {
  focusActiveAgent,
  holdsInAgentView,
  switchView,
  updateKeepingActive,
  updateKeepingFocus,
} from "../agent-view/show";
import { findEditorTab, openOrRevealEditor } from "../editor/tabs";
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
        device: remoteFiles.get(key)?.deviceName || shortId(file.deviceId),
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
        title: target?.title || shortId(remote.tabId),
        device: target?.deviceName || shortId(remote.deviceId),
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

function placeTab(
  key: string,
  options: { panelId?: string; side?: CliSplitSide; index?: number; show: boolean },
) {
  const { panelId, side, index, show } = options;
  if (panelId !== undefined) panelOf(panelId);
  const change = (layout: AgentLayout) =>
    panelId === undefined ? openKey(layout, key) : placeKey(layout, key, panelId, side, index);
  if (show) {
    updateKeepingFocus(change);
    switchView("agents");
  } else {
    updateKeepingActive(change);
  }
  const holder = Grid.findLeafByTab(useAgentViewStore.getState().root, (id) => id === key);
  if (!holder) throw new UiRequestError("the tab did not go into the agent view");
  return { panelId: holder.leaf.id };
}

export const viewHandlers: { [K in ViewOp]: CliUiHandler<K> } = {
  "agentView.reorderSessions": async ({ workspaceId, tabIds }) => ({
    found: reorderSidebarSessions(workspaceId, tabIds),
  }),

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

  "agentView.place": async (args) => {
    if ("key" in args) {
      if (!Grid.findLeafByTab(useAgentViewStore.getState().root, (id) => id === args.key)) {
        throw new UiRequestError("that tab is no longer in the agent view");
      }
      return placeTab(args.key, args);
    }
    const { workspaceId, tabId } = args;
    const tab = tabRecord(workspaceId, tabId);
    if (!holdsInAgentView(tab.type)) {
      throw new UiRequestError(
        "the agent view shows Claude and Codex tabs and terminals, not that tab",
      );
    }
    useMountedWorkspacesStore.getState().mount(workspaceId);
    return placeTab(sessionKey(workspaceId, tabId), args);
  },

  "agentView.openFile": async ({ workspaceId, filePath, panelId }) => {
    if (panelId !== undefined) panelOf(panelId);
    useMountedWorkspacesStore.getState().mount(workspaceId);
    const root = useAgentViewStore.getState().root;
    const { tabId } =
      findEditorTab(
        workspaceId,
        filePath,
        (id) => Grid.findLeafByTab(root, (key) => key === sessionKey(workspaceId, id)) !== null,
      ) ??
      findEditorTab(workspaceId, filePath) ??
      openOrRevealEditor({ workspaceId, filePath }, { preview: false });
    useTabsStore.getState().promoteFromPreview(workspaceId, tabId);
    const key = sessionKey(workspaceId, tabId);
    return { key, tabId, ...placeTab(key, { panelId, show: true }) };
  },

  "agentView.remove": async (args) => {
    const key = "key" in args ? args.key : sessionKey(args.workspaceId, args.tabId);
    updateKeepingActive((layout) => removeKey(layout, key));
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
