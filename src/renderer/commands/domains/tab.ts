/**
 * Tab-domain commands: close (one / others / saved / all), pin toggle.
 */

import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { cacheUriFor } from "../../services/editor/model/cache";
import { isDirty } from "../../services/editor/model/dirty-tracker";
import { closeEditor } from "../../services/editor/tabs";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";
import { closeTabById, getActiveTabContext } from "../context";

/**
 * Cycle the active tab one slot inside the active group's `tabIds` by
 * `delta`, wrapping at both ends. No-op when the group has 0 or 1 tabs,
 * or when there is no active tab context (no workspace / no active leaf).
 *
 * Mirrors `cycleActiveWorkspace` in shape so the two navigation pairs
 * behave consistently (wrap-around, single-slot delta).
 */
function cycleActiveTab(delta: 1 | -1): void {
  const ctx = getActiveTabContext();
  if (!ctx) return;
  const { tabIds } = ctx.leaf;
  if (tabIds.length < 2) return;

  const currentIndex = tabIds.indexOf(ctx.tabId);
  // Active tab id not found in the leaf (mid-removal race) — fall back
  // to the natural end so the keystroke still feels responsive.
  const nextIndex =
    currentIndex < 0
      ? delta === 1
        ? 0
        : tabIds.length - 1
      : (currentIndex + delta + tabIds.length) % tabIds.length;

  useLayoutStore.getState().setActiveTabInGroup({
    workspaceId: ctx.wsId,
    groupId: ctx.leaf.id,
    tabId: tabIds[nextIndex],
    activateGroup: true,
  });
}

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
        if (isDirty(cacheUriFor(tab.props.workspaceId, tab.props.filePath))) continue;
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

    registerCommand(COMMANDS.tabFocusPrev, () => cycleActiveTab(-1)),
    registerCommand(COMMANDS.tabFocusNext, () => cycleActiveTab(1)),
  ];
}
