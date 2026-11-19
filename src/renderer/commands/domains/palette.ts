import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { openWorkspaceSymbolPalette } from "../../state/stores/workspace-symbol-palette";

export function registerPaletteCommands(): Array<() => void> {
  return [registerCommand(COMMANDS.workspaceSymbolSearch, openWorkspaceSymbolPalette)];
}
