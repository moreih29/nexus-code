import { COMMANDS } from "../../../shared/keybindings/commands";
import { showReleaseNotes } from "../../state/operations/release-notes";
import { registerCommand } from "../registry";

export function registerUpdatesCommands(): Array<() => void> {
  return [registerCommand(COMMANDS.updatesReleaseNotes, () => showReleaseNotes())];
}
