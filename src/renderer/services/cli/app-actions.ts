/**
 * The nexus CLI's requests for what is the app's, not a workspace's: the
 * agent manager's dock and conversation, and the Settings dialog shown to
 * the user.
 */

import { useManagerStore } from "@/state/stores/manager";
import { useSettingsUIStore } from "@/state/stores/settings-ui";
import { newManagerConversation } from "../manager/runtime";
import { type CliUiHandler, UiRequestError } from "./handler";

export const appHandlers: {
  "manager.dock": CliUiHandler<"manager.dock">;
  "manager.new": CliUiHandler<"manager.new">;
  "settings.open": CliUiHandler<"settings.open">;
} = {
  "manager.dock": async ({ open }) => {
    const store = useManagerStore.getState();
    if (store.dockOpen !== open) store.setDockOpen(open);
    return { enabled: store.enabled };
  },

  "manager.new": async () => {
    if (!useManagerStore.getState().enabled) {
      throw new UiRequestError("the agent manager is off (Settings › Agent manager)");
    }
    newManagerConversation();
    return {};
  },

  "settings.open": async ({ page }) => {
    const settings = useSettingsUIStore.getState();
    if (page) settings.openSettingsAt(page);
    else settings.openSettings();
    return {};
  },
};
