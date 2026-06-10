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
import { ipcOk } from "../../../shared/ipc/result";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { broadcast, register, validateArgs } from "../../infra/ipc-router";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { installBrowserKeyInterceptor } from "./keyboard";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";
import type { BrowserTabRegistry } from "./registry";

const c = ipcContract.browser.call;
const bp = ipcContract.browserPermission.call;

export interface BrowserChannelDeps {
  readonly promptManager: BrowserPermissionPromptManager;
  readonly workspaceStorage: WorkspaceStorage;
  readonly globalStorage: GlobalStorage;
}

/**
 * Registers the `browser` IPC channel and wires WebContents lifecycle events
 * to broadcast calls.
 *
 * Must be called after the registry is initialised (i.e. after the main
 * window exists).
 */
/**
 * Run a browser command resolved by the key interceptor against `tabId`.
 * Shared by the page-view and docked-DevTools-view interceptors so both
 * surfaces behave identically. Five act on the registry directly; URL
 * focus needs the renderer, so it is bounced over IPC.
 */
function runBrowserCommand(registry: BrowserTabRegistry, command: string, tabId: string): void {
  switch (command) {
    case COMMANDS.browserReload:
      registry.reload({ tabId });
      break;
    case COMMANDS.browserHardReload:
      registry.reload({ tabId, ignoreCache: true });
      break;
    case COMMANDS.browserGoBack:
      registry.goBack({ tabId });
      break;
    case COMMANDS.browserGoForward:
      registry.goForward({ tabId });
      break;
    case COMMANDS.browserFocusUrl:
      broadcast("browser", "focusUrl", { tabId });
      break;
  }
}

export function registerBrowserChannel(
  registry: BrowserTabRegistry,
  channelDeps?: BrowserChannelDeps,
): void {
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

        wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
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
        });

        wc.on("page-title-updated", (_event, title) => {
          broadcast("browser", "titleUpdated", { tabId, title });
        });

        // page-favicon-updated: Chromium이 favicon URL 후보를 발견할 때 발사한다.
        // 페이지가 link rel="icon"을 선언하지 않으면 fallback `/favicon.ico` 시도.
        // renderer는 첫 번째 후보를 탭 아이콘으로 표시한다 (없으면 기본 Globe).
        wc.on("page-favicon-updated", (_event, favicons: string[]) => {
          broadcast("browser", "faviconUpdated", { tabId, favicons });
        });

        // focus: the WebContentsView is a native view painted over the renderer
        // DOM, so a click on the page never bubbles to the renderer's
        // group-activation listeners. Broadcast a focus event so the renderer
        // can activate the group that owns this tab (matches the focus
        // behaviour of every other panel type). Fires only on focus *gain*, so
        // it does not spam on repeated clicks inside an already-focused view.
        wc.on("focus", () => {
          broadcast("browser", "focused", { tabId });
        });

        // Intercept keystrokes that land while the PAGE has focus — they
        // never reach the renderer dispatcher (the WebContentsView is
        // outside the renderer DOM), so match them here and run the
        // browser command. (The docked DevTools view is covered by the
        // registry's DevTools key interceptor wired above.)
        installBrowserKeyInterceptor(wc, tabId, (command, t) =>
          runBrowserCommand(registry, command, t),
        );

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
      faviconUpdated: {},
      focused: {},
    },
  });

  // Register the browserPermission channel only when deps are provided.
  // In tests / legacy paths without deps the channel is not registered.
  if (!channelDeps) return;

  const { promptManager, workspaceStorage, globalStorage } = channelDeps;

  register("browserPermission", {
    call: {
      respond: (args: unknown) => {
        const { promptId, decision, remember } = validateArgs(bp.respond.args, args);
        promptManager.respond(promptId, decision, remember);
        return ipcOk(undefined);
      },

      cancel: (args: unknown) => {
        const { promptId } = validateArgs(bp.cancel.args, args);
        promptManager.cancel(promptId);
        return ipcOk(undefined);
      },

      listRemembered: (args: unknown) => {
        const { workspaceId } = validateArgs(bp.listRemembered.args, args);
        if (workspaceId) {
          // Single-workspace query: only list rows if the workspace DB is open.
          if (!workspaceStorage.isOpen(workspaceId)) {
            return ipcOk([]);
          }
          const rows = workspaceStorage.listOriginPermissions(workspaceId);
          return ipcOk(
            rows.map((r) => ({
              workspaceId,
              origin: r.origin,
              permission:
                r.permission as import("../../../shared/security/browser-permissions").BrowserPermissionKind,
              decision: r.decision,
            })),
          );
        }

        // Global query: enumerate all known workspaces and collect their rows.
        // Only open workspaces contribute — closed workspace DBs are skipped
        // (opening a DB just for a listing call could cause race conditions).
        const workspaces = globalStorage.listWorkspaces();
        const result: {
          workspaceId: string;
          origin: string;
          permission: import("../../../shared/security/browser-permissions").BrowserPermissionKind;
          decision: "allow" | "block";
        }[] = [];
        for (const ws of workspaces) {
          if (!workspaceStorage.isOpen(ws.id)) continue;
          const rows = workspaceStorage.listOriginPermissions(ws.id);
          for (const r of rows) {
            result.push({
              workspaceId: ws.id,
              origin: r.origin,
              permission:
                r.permission as import("../../../shared/security/browser-permissions").BrowserPermissionKind,
              decision: r.decision,
            });
          }
        }
        return ipcOk(result);
      },

      revoke: (args: unknown) => {
        const { workspaceId, origin, permission } = validateArgs(bp.revoke.args, args);
        if (workspaceStorage.isOpen(workspaceId)) {
          workspaceStorage.deleteOriginPermission(workspaceId, origin, permission);
        }
        return ipcOk(undefined);
      },
    },

    listen: {
      prompt: {},
    },
  });
}
