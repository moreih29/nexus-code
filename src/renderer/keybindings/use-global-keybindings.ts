import { useEffect } from "react";
import { registerAgentViewCommands } from "../commands/domains/agent-view";
import { registerBrowserCommands } from "../commands/domains/browser";
import { registerChatPanelCommands } from "../commands/domains/chat-panel";
import { registerFileCommands } from "../commands/domains/file";
import { registerGroupCommands } from "../commands/domains/group";
import { registerPaletteCommands } from "../commands/domains/palette";
import { registerPathCommands } from "../commands/domains/path";
import { registerSettingsCommands } from "../commands/domains/settings";
import { registerTabCommands } from "../commands/domains/tab";
import { registerTerminalCommands } from "../commands/domains/terminal";
import { registerUpdatesCommands } from "../commands/domains/updates";
import { registerVoiceCommands } from "../commands/domains/voice";
import { registerWorkbenchCommands } from "../commands/domains/workbench";
import { registerWorkspaceCommands } from "../commands/domains/workspace";
import { handleGlobalKeyDown } from "./dispatcher";

export function useGlobalKeybindings(): void {
  useEffect(() => {
    const unregister: Array<() => void> = [
      ...registerFileCommands(),
      ...registerTabCommands(),
      ...registerGroupCommands(),
      ...registerPathCommands(),
      ...registerPaletteCommands(),
      ...registerTerminalCommands(),
      ...registerWorkspaceCommands(),
      ...registerSettingsCommands(),
      ...registerUpdatesCommands(),
      ...registerWorkbenchCommands(),
      ...registerBrowserCommands(),
      ...registerAgentViewCommands(),
      ...registerVoiceCommands(),
      ...registerChatPanelCommands(),
    ];

    function onKeyDown(e: KeyboardEvent) {
      if (handleGlobalKeyDown(e)) {
        e.stopImmediatePropagation();
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });

    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      for (const off of unregister) off();
    };
  }, []);
}
