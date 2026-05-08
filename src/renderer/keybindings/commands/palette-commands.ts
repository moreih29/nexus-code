import { COMMANDS } from "../../../shared/commands";
import { registerCommand } from "../../commands/registry";
import { openWorkspaceSymbolPalette } from "../../components/lsp/workspace-symbol/workspace-symbol-palette-state";

export function registerPaletteCommands(): Array<() => void> {
  return [registerCommand(COMMANDS.workspaceSymbolSearch, openWorkspaceSymbolPalette)];
}
