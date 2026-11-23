import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { switchView } from "../../services/agent-view/show";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useUIStore } from "../../state/stores/ui";

export function registerWorkbenchCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.workbenchToggleFilesPanel, () => {
      useUIStore.getState().toggleFilesPanel();
    }),
    registerCommand(COMMANDS.workbenchToggleSidebar, () => {
      useUIStore.getState().toggleSidebar();
    }),
    registerCommand(COMMANDS.workbenchToggleAgentView, () => {
      switchView(useAgentViewStore.getState().mode === "agents" ? "workspace" : "agents");
    }),
  ];
}
