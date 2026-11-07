import { COMMANDS } from "../../../shared/keybindings/commands";
import { showReleaseNotes } from "../../state/operations/release-notes";
import { registerCommand } from "../registry";

/** The release notes, from the app menu or a key the user bound. */
export function registerUpdatesCommands(): Array<() => void> {
  return [registerCommand(COMMANDS.updatesReleaseNotes, () => showReleaseNotes())];
}
