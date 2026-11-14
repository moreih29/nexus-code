import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { toggleDictationByShortcut } from "../../services/voice/dictation";

/** Voice input's shortcut: dictates into the chat box focused last, or stops. */
export function registerVoiceCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.chatVoiceToggle, () => {
      toggleDictationByShortcut();
    }),
  ];
}
