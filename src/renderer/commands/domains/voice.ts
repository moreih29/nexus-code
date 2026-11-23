import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { toggleDictationByShortcut } from "../../services/voice/dictation";

export function registerVoiceCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.chatVoiceToggle, () => {
      toggleDictationByShortcut();
    }),
  ];
}
