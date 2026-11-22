import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { registerContextProbe } from "../../keybindings/context-keys";
import { requestPeerQuickOpen } from "../../services/remote/peer-quick-open";
import { isAgentViewShown } from "../../state/stores/agent-view";
import { peerTargetId, usePeerWorkspaceStore } from "../../state/stores/peer-workspace";
import { openWorkspaceSymbolPalette } from "../../state/stores/workspace-symbol-palette";

export function registerPaletteCommands(): Array<() => void> {
  return [
    registerContextProbe(
      "peerWorkspaceActive",
      () => !isAgentViewShown() && usePeerWorkspaceStore.getState().active !== null,
    ),
    registerCommand(COMMANDS.peerWorkspaceQuickOpen, () => {
      const { active } = usePeerWorkspaceStore.getState();
      if (active && !isAgentViewShown()) requestPeerQuickOpen(peerTargetId(active));
    }),
    registerCommand(COMMANDS.workspaceSymbolSearch, () => {
      if (!usePeerWorkspaceStore.getState().active) openWorkspaceSymbolPalette();
    }),
  ];
}
