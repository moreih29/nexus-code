import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { switchView } from "../../services/agent-view/show";
import { useActiveStore } from "../../state/stores/active";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { FILES_PANEL_MODE_DEFAULT, useUIStore } from "../../state/stores/ui";

/**
 * Workbench-level layout commands: the left side's panels, whose flags
 * live in the UI store and persist via appState, the files panel on its
 * agent list, and the switch between the workspaces and the agent view.
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
    registerCommand(COMMANDS.workbenchToggleAgentsPanel, () => {
      const workspaceId = useActiveStore.getState().activeWorkspaceId;
      if (workspaceId === null) return;
      const ui = useUIStore.getState();
      const mode = ui.filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT;
      if (!ui.filesPanelHidden && mode === "agents") {
        ui.setPanelHidden("files", true);
        return;
      }
      ui.setFilesPanelMode(workspaceId, "agents");
      ui.setPanelHidden("files", false);
    }),
  ];
}
