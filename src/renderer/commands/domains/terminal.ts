import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { openTerminal } from "../../services/terminal/open-terminal";
import { useActiveStore } from "../../state/stores/active";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { newPeerWorkspaceTerminal } from "./peer-workspace";

export function registerTerminalCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.terminalNew, () => {
      const workspaceId = useActiveStore.getState().activeWorkspaceId;
      if (!workspaceId) {
        newPeerWorkspaceTerminal();
        return;
      }
      const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!workspace) return;
      openTerminal({ workspaceId, cwd: workspace.rootPath });
    }),
  ];
}
