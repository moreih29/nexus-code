import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { Grid } from "../../engine";
import { ipcCallResult } from "../../ipc/client";
import { registerContextProbe } from "../../keybindings/context-keys";
import { useActiveStore } from "../../state/stores/active";
import { useBrowserRuntimeStore } from "../../state/stores/browser-runtime";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";

function getActiveBrowserTabId(): string | null {
  const wsId = useActiveStore.getState().activeWorkspaceId;
  if (!wsId) return null;
  const layout = useLayoutStore.getState().byWorkspace[wsId];
  if (!layout) return null;
  const leaf = Grid.findLeaf(layout.root, layout.activeGroupId);
  if (!leaf?.activeTabId) return null;
  const tab = useTabsStore.getState().byWorkspace[wsId]?.[leaf.activeTabId];
  return tab?.type === "browser" ? leaf.activeTabId : null;
}

function withActiveBrowserTab(run: (tabId: string) => void): () => void {
  return () => {
    const tabId = getActiveBrowserTabId();
    if (tabId !== null) run(tabId);
  };
}

export function registerBrowserCommands(): Array<() => void> {
  return [
    registerContextProbe("browserTabActive", () => getActiveBrowserTabId() !== null),

    registerCommand(
      COMMANDS.browserFocusUrl,
      withActiveBrowserTab((tabId) => {
        useBrowserRuntimeStore.getState().requestUrlFocus(tabId);
      }),
    ),
    registerCommand(
      COMMANDS.browserReload,
      withActiveBrowserTab((tabId) => {
        void ipcCallResult("browser", "reload", { tabId });
      }),
    ),
    registerCommand(
      COMMANDS.browserHardReload,
      withActiveBrowserTab((tabId) => {
        void ipcCallResult("browser", "reload", { tabId, ignoreCache: true });
      }),
    ),
    registerCommand(
      COMMANDS.browserGoBack,
      withActiveBrowserTab((tabId) => {
        void ipcCallResult("browser", "goBack", { tabId });
      }),
    ),
    registerCommand(
      COMMANDS.browserGoForward,
      withActiveBrowserTab((tabId) => {
        void ipcCallResult("browser", "goForward", { tabId });
      }),
    ),
  ];
}
