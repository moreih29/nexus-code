/**
 * ⌘⇧] opens and closes the side panel of the chat in front: the active
 * group's active tab in the workspaces, the active panel's agent in the agent
 * view. From the chat's box too, where the user mostly is. Elsewhere (a
 * Codex chat, a terminal, an editor in front) the key is not the app's: the
 * `chatPanelActive` probe below keeps it for what has the keyboard.
 */

import { COMMANDS } from "../../../shared/keybindings/commands";
import { Grid } from "../../engine";
import { registerContextProbe } from "../../keybindings/context-keys";
import { activeKey, isRemoteKey, parseSessionKey } from "../../services/agent-view/layout";
import { hasPanelToggle, togglePanelOf } from "../../services/chat/panel-toggle";
import { useActiveStore } from "../../state/stores/active";
import { isAgentViewShown, useAgentViewStore } from "../../state/stores/agent-view";
import { useLayoutStore } from "../../state/stores/layout";
import { registerCommand } from "../registry";

/** The key the chat in front registered its panel toggle by; null with nothing in front. */
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

/** Whether the chat in front has a side panel. */
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
