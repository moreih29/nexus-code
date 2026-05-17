import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { openWorkspaceSymbolPalette } from "../../components/lsp/workspace-symbol-palette-state";

export function registerPaletteCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.workspaceSymbolSearch, openWorkspaceSymbolPalette),
  ];
}
