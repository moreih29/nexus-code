/**
 * Browser-domain commands: URL-bar focus, reload / hard reload,
 * back / forward, DevTools toggle (Chrome parity for embedded browser
 * tabs).
 *
 * These used to be a hardcoded capture-phase keydown listener inside
 * browser-view.tsx. Routing them through the command registry instead
 * means:
 *   - they live in the declarative KEYBINDINGS table (customizable,
 *     conflict-checkable, label-rendered like every other shortcut);
 *   - the ⌘R/⌘⇧R race against `files.refresh` is resolved by `when`
 *     scoping (`browserTabActive` here, `!browserTabActive` there)
 *     instead of listener registration order — the old component
 *     listener registered *after* the global dispatcher and never saw
 *     ⌘R at all.
 *
 * Target resolution: every command acts on the ACTIVE GROUP's active
 * tab, and only when that tab is a browser tab. This matches the
 * `browserTabActive` context probe registered below, so a binding that
 * resolved through `when: "browserTabActive"` always finds a target.
 */

import { COMMANDS } from "../../../shared/keybindings/commands";
import { registerCommand } from "../../commands/registry";
import { Grid } from "../../engine";
import { ipcCallResult } from "../../ipc/client";
import { registerContextProbe } from "../../keybindings/context-keys";
import { useActiveStore } from "../../state/stores/active";
import { useBrowserRuntimeStore } from "../../state/stores/browser-runtime";
import { useLayoutStore } from "../../state/stores/layout";
import { useTabsStore } from "../../state/stores/tabs";

/**
 * The tabId of the active group's active tab IF that tab is a browser
 * tab; `null` otherwise. State probe — the WebContentsView is a native
 * view outside the renderer DOM, so "focus" cannot be derived from a
 * keydown target the way editor/terminal probes are.
 */
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
    // `when: "browserTabActive"` in the KEYBINDINGS table resolves
    // through this probe on every candidate keydown.
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
    // No DevTools command: ⌘⌥I is the Electron menu role (app DevTools);
    // the browser page's DevTools is opened from the toolbar button.
  ];
}
