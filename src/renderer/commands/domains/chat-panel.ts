import { COMMANDS } from "../../../shared/keybindings/commands";
import { Grid } from "../../engine";
import { registerContextProbe } from "../../keybindings/context-keys";
import { activeKey, isRemoteKey, parseSessionKey } from "../../services/agent-view/layout";
import { hasPanelToggle, togglePanelOf } from "../../services/chat/panel-toggle";
import { useActiveStore } from "../../state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "../../state/stores/agent-view";
import { useLayoutStore } from "../../state/stores/layout";
import { registerCommand } from "../registry";

function frontChatKey(): string | null {
  if (isAgentViewShown()) {
    const key = activeKey(useAgentViewStore.getState());
    if (key === null) return null;
    return isRemoteKey(key) ? key : (parseSessionKey(key)?.tabId ?? null);
  }
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return null;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return null;
  return Grid.findLeaf(layout.root, layout.activeGroupId)?.activeTabId ?? null;
}

export function chatPanelActive(): boolean {
  const key = frontChatKey();
  return key !== null && hasPanelToggle(key);
}

export function registerChatPanelCommands(): Array<() => void> {
  return [
    registerContextProbe("chatPanelActive", chatPanelActive),
    registerCommand(COMMANDS.chatTogglePanel, () => {
      const key = frontChatKey();
      if (key !== null) togglePanelOf(key);
    }),
  ];
}
