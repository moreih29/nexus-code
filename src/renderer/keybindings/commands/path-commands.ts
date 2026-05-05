/**
 * Path-domain commands: reveal in Finder, copy absolute / relative path.
 *
 * Anchored to the currently-active editor's filePath via
 * {@link getActiveEditorPathActions}.
 */

import { COMMANDS } from "../../../shared/commands";
import { registerCommand } from "../../commands/registry";
import { getActiveEditorPathActions } from "./context";

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
