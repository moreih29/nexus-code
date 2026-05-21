import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { useUIStore } from "../../state/stores/ui";

/**
 * Workbench-level layout commands. Currently scoped to left-sidebar
 * visibility — both flags live in the UI store and persist via
 * appState, so the handlers are one-liners that delegate the bookkeeping.
 */
export function registerWorkbenchCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.workbenchToggleFilesPanel, () => {
      useUIStore.getState().toggleFilesPanel();
    }),
    registerCommand(COMMANDS.workbenchToggleSidebar, () => {
      useUIStore.getState().toggleSidebar();
    }),
  ];
}
