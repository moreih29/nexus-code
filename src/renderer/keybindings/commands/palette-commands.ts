import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { openCloneDialog } from "../../components/files/git/clone/dialog-state";
import { openWorkspaceSymbolPalette } from "../../components/lsp/workspace-symbol-palette-state";

export function registerPaletteCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.workspaceSymbolSearch, openWorkspaceSymbolPalette),
    registerCommand(COMMANDS.gitCloneRepository, openCloneDialog),
  ];
}
