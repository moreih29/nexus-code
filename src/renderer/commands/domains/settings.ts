import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { useSettingsUIStore } from "../../state/stores/settings-ui";

export function registerSettingsCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.settingsOpen, () => {
      useSettingsUIStore.getState().toggleSettings();
    }),
  ];
}
