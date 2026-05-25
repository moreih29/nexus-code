/**
 * Browser tab IPC channel — bridges renderer commands to BrowserTabRegistry
 * and broadcasts WebContents lifecycle events back to all renderer windows.
 *
 * BROADCASTS
 * ----------
 * Every browser.* event (navigated, loadingChanged, error, titleUpdated) is
 * sent via the shared `broadcast` helper so all open renderer windows receive
 * it.  The renderer is responsible for filtering by tabId.
 *
 * SECURITY
 * --------
 * All IPC args are validated against the Zod schemas in contract.ts.  The
 * navigation guards (will-navigate, will-frame-navigate, setWindowOpenHandler)
 * are applied by the registry at WebContents-creation time — they are NOT
 * bypassed here.
 *
 * DESIGN NOTE: WHY WE ATTACH LISTENERS IN registerBrowserChannel
 * Attaching WebContents event listeners here (rather than in registry.create)
 * separates concerns:
 *   - registry.ts owns the WebContentsView lifetime and security policy.
 *   - ipc.ts owns the IPC wire-up and broadcast logic.
 * This keeps registry.ts testable without an IPC router mock.
 */

import { ipcContract } from "../../../shared/ipc/contract";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import { ipcOk } from "../../../shared/ipc/result";
import type { BrowserTabRegistry } from "./registry";

const c = ipcContract.browser.call;

/**
 * Registers the `browser` IPC channel and wires WebContents lifecycle events
 * to broadcast calls.
 *
 * Must be called after the registry is initialised (i.e. after the main
 * window exists).
 */
export function registerBrowserChannel(registry: BrowserTabRegistry): void {
  register("browser", {
    call: {
      create: (args: unknown) => {
        const { tabId, workspaceId, url, partition } = validateArgs(c.create.args, args);
        registry.create({ tabId, workspaceId, url, partition });

        // Wire WebContents lifecycle events for broadcasts.
        // The entry was just created so it MUST be present.
        const entry = registry.get(tabId);
        if (!entry) return ipcOk(undefined); // Should never happen; guard for safety.

        const wc = entry.view.webContents;

        wc.on("did-navigate", (_event, navUrl, _httpResponseCode, _httpStatusText) => {
          broadcast("browser", "navigated", {
            tabId,
            url: navUrl,
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
          });
        });

        wc.on("did-navigate-in-page", (_event, navUrl) => {
          broadcast("browser", "navigated", {
            tabId,
            url: navUrl,
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
          });
        });

        wc.on("did-start-loading", () => {
          broadcast("browser", "loadingChanged", { tabId, isLoading: true });
        });

        wc.on("did-stop-loading", () => {
          broadcast("browser", "loadingChanged", { tabId, isLoading: false });
        });

        wc.on(
          "did-fail-load",
          (_event, errorCode, errorDescription, validatedURL) => {
            broadcast("browser", "error", {
              tabId,
              code: errorCode,
              description: errorDescription,
              url: validatedURL,
            });
            // Loading has ended (failed) — ensure isLoading is toggled off
            // even when did-stop-loading fires before the renderer processes
            // this event.
            broadcast("browser", "loadingChanged", { tabId, isLoading: false });
          },
        );

        wc.on("page-title-updated", (_event, title) => {
          broadcast("browser", "titleUpdated", { tabId, title });
        });

        return ipcOk(undefined);
      },

      destroy: (args: unknown) => {
        const { tabId } = validateArgs(c.destroy.args, args);
        registry.destroy({ tabId });
        return ipcOk(undefined);
      },

      setBounds: (args: unknown) => {
        const { tabId, x, y, width, height } = validateArgs(c.setBounds.args, args);
        registry.setBounds({ tabId, x, y, width, height });
        return ipcOk(undefined);
      },

      setActive: (args: unknown) => {
        const { tabId, active } = validateArgs(c.setActive.args, args);
        registry.setActive({ tabId, active });
        return ipcOk(undefined);
      },

      navigate: (args: unknown) => {
        const { tabId, url } = validateArgs(c.navigate.args, args);
        registry.navigate({ tabId, url });
        return ipcOk(undefined);
      },

      goBack: (args: unknown) => {
        const { tabId } = validateArgs(c.goBack.args, args);
        registry.goBack({ tabId });
        return ipcOk(undefined);
      },

      goForward: (args: unknown) => {
        const { tabId } = validateArgs(c.goForward.args, args);
        registry.goForward({ tabId });
        return ipcOk(undefined);
      },

      reload: (args: unknown) => {
        const { tabId, ignoreCache } = validateArgs(c.reload.args, args);
        registry.reload({ tabId, ignoreCache });
        return ipcOk(undefined);
      },

      openDevTools: (args: unknown) => {
        const { tabId } = validateArgs(c.openDevTools.args, args);
        const { open } = registry.openDevTools({ tabId });
        // Tell the renderer to show/hide the splitter and start/stop
        // reporting setDevToolsBounds for this tab.
        broadcast("browser", "devtoolsToggled", { tabId, open });
        return ipcOk(undefined);
      },

      setDevToolsBounds: (args: unknown) => {
        const { tabId, x, y, width, height } = validateArgs(c.setDevToolsBounds.args, args);
        registry.setDevToolsBounds({ tabId, x, y, width, height });
        return ipcOk(undefined);
      },

      suspendAll: async (args: unknown) => {
        const { captureSnapshot } = validateArgs(c.suspendAll.args, args);
        // The registry's suspendAll captures BEFORE hiding (VSCode pattern) so
        // the renderer can overlay each snapshot on top of the still-visible
        // placeholder before the native view goes dark — no flash, no blank.
        const snapshots = await registry.suspendAll({ captureSnapshot });
        for (const { tabId, dataUrl } of snapshots) {
          // Only broadcast when capture succeeded and produced a usable
          // payload; tiny/empty captures arrive as null and the renderer
          // keeps the prior placeholder without harm.
          if (dataUrl !== null) {
            broadcast("browser", "snapshot", { kind: "set", tabId, dataUrl });
          }
        }
        return ipcOk(undefined);
      },

      resumeAll: (args: unknown) => {
        validateArgs(c.resumeAll.args, args);
        const resumed = registry.resumeAll();
        for (const tabId of resumed) {
          // Drop the cached snapshot in the renderer so the live view shows
          // through again.  Sent even when no snapshot was previously
          // broadcast for this tab (e.g. drag-mode suspend with
          // captureSnapshot=false) — harmless on the renderer side.
          broadcast("browser", "snapshot", { kind: "cleared", tabId });
        }
        return ipcOk(undefined);
      },
    },

    listen: {
      navigated: {},
      loadingChanged: {},
      error: {},
      titleUpdated: {},
      snapshot: {},
      devtoolsToggled: {},
    },
  });
}
