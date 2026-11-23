import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { getActiveEditorPathActions } from "../context";

export function registerPathCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.pathReveal, () => {
      getActiveEditorPathActions()?.revealInFinder();
    }),
    registerCommand(COMMANDS.pathCopy, () => {
      getActiveEditorPathActions()?.copyPath();
    }),
    registerCommand(COMMANDS.pathCopyRelative, () => {
      getActiveEditorPathActions()?.copyRelativePath();
    }),
  ];
}
