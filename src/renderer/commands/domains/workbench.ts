import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { switchView } from "../../services/agent-view/show";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useUIStore } from "../../state/stores/ui";

/**
 * Workbench-level layout commands: the left side's panels, whose flags
 * live in the UI store and persist via appState, and the switch between
 * the workspaces and the agent view.
 *
 * (DevTools toggle, ⌘⌥I, lives in the browser command domain — its target
 * depends on the active browser tab.)
 */
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
