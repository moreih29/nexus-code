/**
 * Browser tab IPC channel — bridges renderer commands to BrowserTabRegistry
 * and routes WebContents lifecycle events to the renderer that created the view.
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
import { ipcErr, ipcOk } from "../../../shared/ipc/result";
import { COMMANDS } from "../../../shared/keybindings/commands";
import { broadcast, type CallContext, register, validateArgs } from "../../infra/ipc-router";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { appWindowOf, getActiveAppWindow } from "../window/app-windows";
import { noticeDownloads } from "./downloads";
import { installBrowserKeyInterceptor } from "./keyboard";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";
import type { BrowserHostWindow, BrowserTabRegistry } from "./registry";

/**
 * Whether the app renderer may load a page-supplied favicon URL. The tab bar
 * fetches it from the app's own session, not the tab's partition, so a page
 * must not be able to point it at file:// or nexus-workspace://.
 */
export function isLoadableFaviconUrl(url: string): boolean {
  return /^(https?:|data:image\/)/i.test(url);
}

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
 * Run a command resolved by the key interceptor against `tabId`.
 * Shared by the page-view and docked-DevTools-view interceptors so both
 * surfaces behave identically. Five browser commands act on the registry
 * directly; URL focus needs the renderer, so it is bounced over IPC. App
 * commands (tabs, groups, workspaces…) run in the app window.
 */
function runBrowserCommand(
  registry: BrowserTabRegistry,
  command: string,
  tabId: string,
  focusUrl: () => void,
): void {
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
      focusUrl();
      break;
    default: {
      // As if the key had been pressed in the app window: that window takes
      // the keyboard focus back from the page and runs the command.
      const win = getActiveAppWindow();
      if (!win || win.isDestroyed()) return;
      win.webContents.focus();
      win.webContents.send("ipc:event", "command", "invoke", { id: command });
    }
  }
}

export function registerBrowserChannel(
  registry: BrowserTabRegistry,
  channelDeps?: BrowserChannelDeps,
  windowOf: (sender: { readonly id: number }) => BrowserHostWindow | null = appWindowOf,
): void {
  type Owner = { viewId: string; sender: NonNullable<CallContext["sender"]> };
  const owners = new Map<string, Owner>();

  /** Publish current-generation events directly to the view's renderer. */
  function sendViewEvent(
    tabId: string,
    event: string,
    payload: Record<string, unknown>,
    owner = owners.get(tabId),
  ): void {
    if (!owner || owners.get(tabId) !== owner || owner.sender.isDestroyed()) return;
    owner.sender.send("ipc:event", "browser", event, { ...payload, tabId, viewId: owner.viewId });
  }

  /** Resolve a request from the owning renderer, optionally for a particular generation. */
  function ownsView(tabId: string, ctx: CallContext | undefined, viewId?: string): boolean {
    const owner = owners.get(tabId);
    return (
      owner !== undefined &&
      owner.sender.id === ctx?.sender?.id &&
      (viewId === undefined || viewId === owner.viewId)
    );
  }

  registry.onLoadFailure((tabId, failure) => {
    sendViewEvent(tabId, "loadFailureChanged", { failure });
  });
  registry.onRefused((tabId, url, error) => {
    const { kind, reason } = error as { kind?: unknown; reason?: unknown };
    sendViewEvent(tabId, "refused", {
      url,
      kind: typeof kind === "string" ? kind : "failed",
      message: typeof reason === "string" ? reason : error.message,
    });
  });
  register("browser", {
    call: {
      create: (args: unknown, ctx) => {
        const { tabId, viewId, workspaceId, url, partition } = validateArgs(c.create.args, args);
        if (!ctx?.sender) return ipcErr("not-found", "Browser renderer is unavailable");
        const win = windowOf(ctx.sender);
        if (!win) return ipcErr("not-found", "Browser renderer is unavailable");
        const previous = owners.get(tabId);
        if (previous && previous.sender.id !== ctx.sender.id && !previous.sender.isDestroyed()) {
          return ipcErr("conflict", "Browser tab is open in another window");
        }
        // Dispose the old generation before allowing the new one to emit.
        owners.delete(tabId);
        if (registry.get(tabId)) registry.destroy({ tabId });
        const owner = { viewId, sender: ctx.sender };
        owners.set(tabId, owner);
        try {
          registry.create({ tabId, workspaceId, url, partition, win });
        } catch (error) {
          owners.delete(tabId);
          return ipcErr("browser-create-failed", String(error), { category: "bug" });
        }

        // Wire WebContents lifecycle events for broadcasts.
        // The entry was just created so it MUST be present.
        const entry = registry.get(tabId);
        if (!entry) {
          owners.delete(tabId);
          return ipcErr("browser-create-failed", "Browser view was not created", {
            category: "bug",
          });
        }

        const wc = entry.view.webContents;
        wc.once("destroyed", () => {
          if (owners.get(tabId) === owner) owners.delete(tabId);
        });
        const emit = (event: string, value: Record<string, unknown>) =>
          sendViewEvent(tabId, event, value, owner);
        noticeDownloads(wc.session, (_from, file) => broadcast("browser", "downloaded", { file }));

        wc.on("did-navigate", (_event, navUrl, _httpResponseCode, _httpStatusText) => {
          emit("navigated", {
            url: navUrl,
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
          });
        });

        wc.on("did-navigate-in-page", (_event, navUrl, isMainFrame) => {
          if (!isMainFrame) return;
          emit("navigated", {
            url: navUrl,
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
          });
        });

        wc.on("did-start-loading", () => {
          emit("loadingChanged", { isLoading: true });
        });

        wc.on("did-stop-loading", () => {
          emit("loadingChanged", { isLoading: false });
        });

        wc.on("page-title-updated", (_event, title) => {
          emit("titleUpdated", { title });
        });

        // page-favicon-updated: fires when Chromium finds favicon URL candidates.
        // If the page does not declare link rel="icon", the fallback `/favicon.ico` is tried.
        // The renderer shows the first candidate as the tab icon (the default Globe if none).
        wc.on("page-favicon-updated", (_event, favicons: string[]) => {
          emit("faviconUpdated", {
            favicons: favicons.filter(isLoadableFaviconUrl),
          });
        });

        // focus: the WebContentsView is a native view painted over the renderer
        // DOM, so a click on the page never bubbles to the renderer's
        // group-activation listeners. Broadcast a focus event so the renderer
        // can activate the group that owns this tab (matches the focus
        // behaviour of every other panel type). Fires only on focus *gain*, so
        // it does not spam on repeated clicks inside an already-focused view.
        wc.on("focus", () => {
          emit("focused", {});
        });

        // Intercept keystrokes that land while the PAGE has focus — they
        // never reach the renderer dispatcher (the WebContentsView is
        // outside the renderer DOM), so match them here and run the
        // browser command. (The docked DevTools view is covered by the
        // registry's DevTools key interceptor wired above.)
        installBrowserKeyInterceptor(wc, tabId, (command, t) =>
          runBrowserCommand(registry, command, t, () => emit("focusUrl", {})),
        );

        return ipcOk(undefined);
      },

      destroy: (args: unknown, ctx) => {
        const { tabId, viewId } = validateArgs(c.destroy.args, args);
        if (!ownsView(tabId, ctx, viewId)) return ipcOk(undefined);
        owners.delete(tabId);
        registry.destroy({ tabId });
        return ipcOk(undefined);
      },

      setBounds: (args: unknown, ctx) => {
        const { tabId, viewId, x, y, width, height } = validateArgs(c.setBounds.args, args);
        if (!ownsView(tabId, ctx, viewId)) return ipcOk(undefined);
        registry.setBounds({ tabId, x, y, width, height });
        return ipcOk(undefined);
      },

      setActive: (args: unknown, ctx) => {
        const { tabId, viewId, active } = validateArgs(c.setActive.args, args);
        if (!ownsView(tabId, ctx, viewId)) return ipcOk(undefined);
        registry.setActive({ tabId, active });
        return ipcOk(undefined);
      },

      navigate: (args: unknown, ctx) => {
        const { tabId, url } = validateArgs(c.navigate.args, args);
        if (!ownsView(tabId, ctx)) return ipcOk(undefined);
        registry.navigate({ tabId, url });
        return ipcOk(undefined);
      },

      goBack: (args: unknown, ctx) => {
        const { tabId } = validateArgs(c.goBack.args, args);
        if (!ownsView(tabId, ctx)) return ipcOk(undefined);
        registry.goBack({ tabId });
        return ipcOk(undefined);
      },

      goForward: (args: unknown, ctx) => {
        const { tabId } = validateArgs(c.goForward.args, args);
        if (!ownsView(tabId, ctx)) return ipcOk(undefined);
        registry.goForward({ tabId });
        return ipcOk(undefined);
      },

      reload: (args: unknown, ctx) => {
        const { tabId, ignoreCache } = validateArgs(c.reload.args, args);
        if (!ownsView(tabId, ctx)) return ipcOk(undefined);
        registry.reload({ tabId, ignoreCache });
        return ipcOk(undefined);
      },

      openDevTools: (args: unknown, ctx) => {
        const { tabId } = validateArgs(c.openDevTools.args, args);
        if (!ownsView(tabId, ctx)) return ipcOk(undefined);
        const { open } = registry.openDevTools({ tabId });
        // Tell the renderer to show/hide the splitter and start/stop
        // reporting setDevToolsBounds for this tab.
        sendViewEvent(tabId, "devtoolsToggled", { open });
        return ipcOk(undefined);
      },

      setDevToolsBounds: (args: unknown, ctx) => {
        const { tabId, viewId, x, y, width, height } = validateArgs(c.setDevToolsBounds.args, args);
        if (!ownsView(tabId, ctx, viewId)) return ipcOk(undefined);
        registry.setDevToolsBounds({ tabId, x, y, width, height });
        return ipcOk(undefined);
      },

      suspendAll: async (args: unknown, ctx) => {
        const { captureSnapshot } = validateArgs(c.suspendAll.args, args);
        if (!ctx?.sender) return ipcOk(undefined);
        // Capture before hiding so the renderer can show the last frame under the overlay.
        const capturing = new Map(owners);
        const snapshots = await registry.suspendAll({ captureSnapshot, windowId: ctx.sender.id });
        for (const { tabId, dataUrl } of snapshots) {
          const owner = capturing.get(tabId);
          if (owner) sendViewEvent(tabId, "snapshot", { kind: "set", dataUrl }, owner);
        }
        return ipcOk(undefined);
      },

      resumeAll: (args: unknown, ctx) => {
        validateArgs(c.resumeAll.args, args);
        if (!ctx?.sender) return ipcOk(undefined);
        for (const tabId of registry.resumeAll(ctx.sender.id)) {
          sendViewEvent(tabId, "snapshot", { kind: "cleared" });
        }
        return ipcOk(undefined);
      },
    },

    listen: {
      navigated: {},
      loadingChanged: {},
      loadFailureChanged: {},
      refused: {},
      titleUpdated: {},
      snapshot: {},
      devtoolsToggled: {},
      faviconUpdated: {},
      focused: {},
      downloaded: {},
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
