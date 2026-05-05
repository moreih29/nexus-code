/**
 * Tab-domain commands: close (one / others / saved / all), pin toggle.
 */

import { COMMANDS } from "../../../shared/commands";
import { registerCommand } from "../../commands/registry";
import { closeEditor, filePathToModelUri, isDirty } from "../../services/editor";
import { useTabsStore } from "../../state/stores/tabs";
import { closeTabById, getActiveTabContext } from "./context";

export function registerTabCommands(): Array<() => void> {
  return [
    registerCommand(COMMANDS.tabClose, () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      void closeTabById(ctx.wsId, ctx.tabId);
    }),

    registerCommand(COMMANDS.tabCloseOthers, async () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      // Pin protection mirrors `useGroupActions.closeOthers`.
      const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
      const others = ctx.leaf.tabIds.filter((id) => id !== ctx.tabId && !wsRecord[id]?.isPinned);
      for (const id of others) {
        const outcome = await closeTabById(ctx.wsId, id);
        if (outcome === "cancelled") return;
      }
    }),

    registerCommand(COMMANDS.tabCloseSaved, () => {
      // Close every editor tab in the active group whose buffer is
      // clean. No confirms — saved-clean tabs by definition have no
      // unsaved work. Mirrors `useGroupActions.closeSaved`.
      const ctx = getActiveTabContext();
      if (!ctx) return;
      const wsRecord = useTabsStore.getState().byWorkspace[ctx.wsId] ?? {};
      for (const id of ctx.leaf.tabIds) {
        const tab = wsRecord[id];
        if (tab?.type !== "editor") continue;
        if (isDirty(filePathToModelUri(tab.props.filePath))) continue;
        closeEditor(id);
      }
    }),

    registerCommand(COMMANDS.tabCloseAll, async () => {
      // VSCode "Close All Editors": closes pinned tabs too — pin only
      // protects against bulk Close Others / Close-to-Right gestures.
      const ctx = getActiveTabContext();
      if (!ctx) return;
      for (const id of [...ctx.leaf.tabIds]) {
        const outcome = await closeTabById(ctx.wsId, id);
        if (outcome === "cancelled") return;
      }
    }),

    registerCommand(COMMANDS.tabPinToggle, () => {
      const ctx = getActiveTabContext();
      if (!ctx) return;
      useTabsStore.getState().togglePin(ctx.wsId, ctx.tabId);
    }),
  ];
}
