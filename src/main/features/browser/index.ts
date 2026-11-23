import type { WebContents } from "electron";
import type { GlobalStorage } from "../../infra/storage/global-storage";
import type { WorkspaceStorage } from "../../infra/storage/workspace-storage";
import { type BrowserChannelDeps, registerBrowserChannel } from "./ipc";
import type { BrowserPermissionPromptManager } from "./permission-prompt-manager";
import { type BrowserAddressResolver, BrowserTabRegistry } from "./registry";
import type { PermissionHandlerDeps } from "./security";

let registry: BrowserTabRegistry | null = null;
const createListeners = new Set<(tabId: string, contents: WebContents) => void>();
let addressResolver: BrowserAddressResolver | null = null;

export interface BrowserFeatureDeps {
  readonly permissionDeps?: PermissionHandlerDeps;
  readonly promptManager?: BrowserPermissionPromptManager;
  readonly workspaceStorage?: WorkspaceStorage;
  readonly globalStorage?: GlobalStorage;
}

export function initBrowserFeature(deps?: BrowserFeatureDeps): void {
  registry = new BrowserTabRegistry(deps?.permissionDeps);
  for (const listener of createListeners) registry.onCreate(listener);
  registry.setAddressResolver(addressResolver);

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

export function setBrowserAddressResolver(resolver: BrowserAddressResolver | null): void {
  addressResolver = resolver;
  registry?.setAddressResolver(resolver);
}

export function getBrowserRegistry(): BrowserTabRegistry | null {
  return registry;
}

export function onBrowserTabCreated(
  listener: (tabId: string, contents: WebContents) => void,
): () => void {
  createListeners.add(listener);
  const stop = registry?.onCreate(listener);
  return () => {
    createListeners.delete(listener);
    stop?.();
  };
}

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
      reg.closePopups(workspaceId);
    }
    const { session } = require("electron") as typeof import("electron");
    await session.fromPartition(`persist:browser-${workspaceId}`).clearStorageData();
  });
}
