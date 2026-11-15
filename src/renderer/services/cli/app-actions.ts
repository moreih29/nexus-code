/**
 * The nexus CLI's requests for what is the app's, not a workspace's: the
 * Settings dialog shown to the user.
 */

import { useSettingsUIStore } from "@/state/stores/settings-ui";
import type { CliUiHandler } from "./handler";

export const appHandlers: {
  "settings.open": CliUiHandler<"settings.open">;
} = {
  "settings.open": async ({ page }) => {
    const settings = useSettingsUIStore.getState();
    if (page) settings.openSettingsAt(page);
    else settings.openSettings();
    return {};
  },
};
