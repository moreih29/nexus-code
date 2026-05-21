import { COMMANDS } from "../../../shared/keybindings/commands";
import { useSettingsUIStore } from "../../state/stores/settings-ui";
import { registerCommand } from "../../commands/registry";

/**
 * Settings dialog open command. Toggle (not open-only) so the same
 * shortcut closes the dialog if it's already open — matches the macOS
 * Preferences convention where ⌘, behaves as a focus/dismiss toggle.
 */
export function registerSettingsCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.settingsOpen, () => {
      useSettingsUIStore.getState().toggleSettings();
    }),
  ];
}
