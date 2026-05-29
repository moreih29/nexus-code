/**
 * Browser feature — public interface.
 *
 * Call `initBrowserFeature(win)` once after the main BrowserWindow is created.
 * Afterwards use `getRegistry()` to obtain the singleton BrowserTabRegistry
 * (useful for cleanup on window close).
 *
 * USAGE (src/main/index.ts)
 * -------------------------
 *   import { initBrowserFeature, getBrowserRegistry } from "./features/browser";
 *
 *   // Inside app.whenReady() after createMainWindow():
 *   initBrowserFeature(mainWindow);
 *
 *   // On window close (optional — disposeAll is idempotent):
 *   mainWindow.on("closed", () => {
 *     getBrowserRegistry()?.disposeAll();
 *   });
 */

import type { BrowserWindow } from "electron";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";
import { BrowserTabRegistry } from "./registry";
import type { PermissionHandlerDeps } from "./security";
import { type BrowserChannelDeps, registerBrowserChannel } from "./ipc";

let registry: BrowserTabRegistry | null = null;

export interface BrowserFeatureDeps {
  readonly permissionDeps?: PermissionHandlerDeps;
  readonly promptManager?: BrowserPermissionPromptManager;
  readonly workspaceStorage?: WorkspaceStorage;
  readonly globalStorage?: GlobalStorage;
}

/**
 * Initialises the browser feature for the given `BrowserWindow`.
 *
 * Creates the singleton `BrowserTabRegistry` bound to `win` and registers
 * the `browser` IPC channel.  When `deps` carries a `promptManager`,
 * `workspaceStorage`, and `globalStorage`, the `browserPermission` IPC channel
 * is also registered.
 *
 * Calling this more than once replaces the previous registry — the caller is
 * responsible for disposing any open tabs before reinitialising.
 */
export function initBrowserFeature(win: BrowserWindow, deps?: BrowserFeatureDeps): void {
  registry = new BrowserTabRegistry(win, deps?.permissionDeps);

  let channelDeps: BrowserChannelDeps | undefined;
  if (deps?.promptManager && deps.workspaceStorage && deps.globalStorage) {
    channelDeps = {
      promptManager: deps.promptManager,
      workspaceStorage: deps.workspaceStorage,
      globalStorage: deps.globalStorage,
    };
  }

  registerBrowserChannel(registry, channelDeps);
}

/**
 * Returns the active `BrowserTabRegistry`, or `null` if `initBrowserFeature`
 * has not yet been called.
 */
export function getBrowserRegistry(): BrowserTabRegistry | null {
  return registry;
}

/**
 * Wires the browser closer into a `WorkspaceManager`-compatible object.
 *
 * The closer:
 *   1. Destroys all `WebContentsView`s for the given workspace.
 *   2. After all destroys complete, clears the workspace's storage partition
 *      via `session.fromPartition(...).clearStorageData()`.
 *
 * Call this once after both `initBrowserFeature` and `WorkspaceManager` are
 * initialised — mirrors the `setPtySessionCloser` wiring in main/index.ts.
 */
export function registerBrowserCloser(manager: {
  setBrowserCloser(closer: (workspaceId: string) => Promise<void>): void;
}): void {
  manager.setBrowserCloser(async (workspaceId: string) => {
    const reg = registry;
    if (reg) {
      const tabIds = reg.listByWorkspace(workspaceId);
      for (const tabId of tabIds) {
        reg.destroy({ tabId });
      }
    }
    const { session } = require("electron") as typeof import("electron");
    await session
      .fromPartition(`persist:browser-${workspaceId}`)
      .clearStorageData();
  });
}
