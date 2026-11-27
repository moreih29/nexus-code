import type { BrowserWindow, WebContents } from "electron";
import { WebContentsView } from "electron";
import { createLogger } from "../../../shared/log/main";
import { isTabLoadAllowed } from "../../../shared/security/navigation-allowlist";
import { excludeFromBroadcast } from "../../infra/ipc-router";
import { showDialogsOverWindow } from "./dialogs";
import { installLocalFileReadGuard } from "./local-files";
import { installAppScrollbarStyle } from "./page-style";
import { PopupTracker } from "./popup-tracker";
import {
  buildBrowserTabWebPreferences,
  installNavigationGuards,
  installPermissionHandler,
  type PermissionHandlerDeps,
} from "./security";

const logger = createLogger("browser-registry");

export type BrowserHostWindow = Pick<
  BrowserWindow,
  "contentView" | "webContents" | "isDestroyed" | "isVisible" | "isMinimized"
>;

interface TabEntry {
  view: WebContentsView;
  readonly win: BrowserHostWindow;
  readonly windowId: number;
  workspaceId: string;
  partition: string;
  loadFailure: BrowserLoadFailure | null;
  requestedUrl: string;
  navigationRequest: number;
  forwardedAddress: { requested: string; target: string } | null;
  active: boolean;
  lastBounds: CssBounds | null;
  devtoolsView: WebContentsView | null;
  devtoolsBounds: CssBounds | null;
  devtoolsOpen: boolean;
}

export interface CssBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAddressResolver {
  rewrites(workspaceId: string, url: string): boolean;
  resolve(workspaceId: string, url: string): Promise<string>;
}

export interface BrowserLoadFailure {
  url: string;
  description: string;
  code?: number;
}

interface SuspendSnapshot {
  tabId: string;
  dataUrl: string;
}

export class BrowserTabRegistry {
  private readonly tabs = new Map<string, TabEntry>();
  private readonly popups = new PopupTracker();
  private readonly permissionDeps: PermissionHandlerDeps | undefined;
  private readonly suspendedWindows = new Set<number>();
  private readonly suspendGenerations = new Map<number, number>();
  private readonly snapshotTabs = new Map<string, number>();
  private readonly createListeners = new Set<(tabId: string, contents: WebContents) => void>();
  private addressResolver: BrowserAddressResolver | null = null;
  private readonly refusedListeners = new Set<(tabId: string, url: string, error: Error) => void>();
  private readonly loadFailureListeners = new Set<
    (tabId: string, failure: BrowserLoadFailure | null) => void
  >();

  constructor(permissionDeps?: PermissionHandlerDeps) {
    this.permissionDeps = permissionDeps;
  }

  private isSuspended(entry: TabEntry): boolean {
    return this.suspendedWindows.has(entry.windowId);
  }

  private nextSuspendGeneration(windowId: number): number {
    const next = (this.suspendGenerations.get(windowId) ?? 0) + 1;
    this.suspendGenerations.set(windowId, next);
    return next;
  }

  create(args: {
    tabId: string;
    workspaceId: string;
    url: string;
    partition: string;
    win: BrowserHostWindow;
  }): void {
    const { tabId, workspaceId, url, partition, win } = args;

    if (this.tabs.has(tabId)) {
      logger.warn(`[create] tabId ${tabId} already exists — destroying and recreating`);
      this.destroy({ tabId });
    }

    const webPreferences = buildBrowserTabWebPreferences(partition);
    const view = new WebContentsView({ webPreferences });

    const entry: TabEntry = {
      view,
      win,
      windowId: win.webContents.id,
      workspaceId,
      partition,
      loadFailure: null,
      requestedUrl: url,
      navigationRequest: 0,
      forwardedAddress: null,
      active: false,
      lastBounds: null,
      devtoolsView: null,
      devtoolsBounds: null,
      devtoolsOpen: false,
    };
    this.tabs.set(tabId, entry);
    installPermissionHandler(view.webContents.session, this.permissionDeps, workspaceId);
    installLocalFileReadGuard(view.webContents);
    installNavigationGuards(view.webContents, undefined, (popup) =>
      this.popups.track(workspaceId, popup),
    );
    installAppScrollbarStyle(view.webContents);
    showDialogsOverWindow(view.webContents, () => win as BrowserWindow);
    view.webContents.setBackgroundThrottling(true);

    view.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument, url }) => {
      if (isMainFrame && !isSameDocument) entry.requestedUrl = url;
    });
    view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      const forward = entry.forwardedAddress;
      this.setLoadFailure(tabId, entry, {
        url: forward?.target === url ? forward.requested : url || entry.requestedUrl,
        description: description || `NET_ERROR_${code}`,
        code,
      });
    });
    view.webContents.on("did-navigate", () => this.setLoadFailure(tabId, entry, null));
    view.webContents.on("render-process-gone", () => {
      entry.navigationRequest++;
      const url = view.webContents.isLoadingMainFrame()
        ? entry.requestedUrl
        : view.webContents.getURL();
      this.setLoadFailure(tabId, entry, {
        url:
          entry.loadFailure?.url ??
          entry.forwardedAddress?.requested ??
          (url || entry.requestedUrl),
        description: "ERR_RENDER_PROCESS_GONE",
      });
    });
    for (const listener of this.createListeners) listener(tabId, view.webContents);

    view.webContents.on("will-navigate", (event, target) => {
      if (event.defaultPrevented) return;
      if (!this.addressResolver?.rewrites(workspaceId, target)) {
        entry.navigationRequest++;
        entry.forwardedAddress = null;
        return;
      }
      event.preventDefault();
      this.load(tabId, entry, target, "will-navigate");
    });

    this.load(tabId, entry, url, "create");

    logger.debug(`[create] tab ${tabId} created (partition=${partition})`);
  }

  onCreate(listener: (tabId: string, contents: WebContents) => void): () => void {
    this.createListeners.add(listener);
    return () => this.createListeners.delete(listener);
  }

  setAddressResolver(resolver: BrowserAddressResolver | null): void {
    this.addressResolver = resolver;
  }

  onRefused(listener: (tabId: string, url: string, error: Error) => void): () => void {
    this.refusedListeners.add(listener);
    return () => this.refusedListeners.delete(listener);
  }

  onLoadFailure(listener: (tabId: string, failure: BrowserLoadFailure | null) => void): void {
    this.loadFailureListeners.add(listener);
  }

  private setLoadFailure(tabId: string, entry: TabEntry, failure: BrowserLoadFailure | null): void {
    if (this.tabs.get(tabId) !== entry || (failure === null && entry.loadFailure === null)) return;
    entry.loadFailure = failure;
    if (entry.active) entry.view.setVisible(!this.isSuspended(entry) && failure === null);
    for (const listener of this.loadFailureListeners) listener(tabId, failure);
  }

  private load(tabId: string, entry: TabEntry, url: string, label: string): void {
    const request = ++entry.navigationRequest;
    entry.forwardedAddress = null;
    entry.requestedUrl = url;
    if (!isTabLoadAllowed(url)) {
      logger.warn(`[${label}] disallowed address in ${tabId}`);
      this.setLoadFailure(tabId, entry, { url, description: "ERR_DISALLOWED_URL_SCHEME" });
      return;
    }
    const isCurrent = () =>
      this.tabs.get(tabId) === entry &&
      entry.navigationRequest === request &&
      !entry.view.webContents.isDestroyed();
    const loadNow = (target: string) => {
      const previousFailure = entry.loadFailure;
      entry.view.webContents.loadURL(target).catch((error: { code?: string; errno?: number }) => {
        if (!isCurrent() || error.errno === -3 || error.code === "ERR_ABORTED") return;
        logger.warn(`[${label}] loadURL failed for ${tabId}`);
        if (
          entry.loadFailure !== previousFailure ||
          error.errno === -2 ||
          error.code === "ERR_FAILED" ||
          !error.code
        ) {
          return;
        }
        this.setLoadFailure(tabId, entry, {
          url,
          description: error.code,
          ...(typeof error.errno === "number" ? { code: error.errno } : {}),
        });
      });
    };
    const resolver = this.addressResolver;
    if (!resolver?.rewrites(entry.workspaceId, url)) {
      loadNow(url);
      return;
    }
    resolver.resolve(entry.workspaceId, url).then(
      (resolved) => {
        if (!isCurrent()) return;
        entry.forwardedAddress = { requested: url, target: resolved };
        loadNow(resolved);
      },
      (error: Error) => {
        if (!isCurrent()) return;
        logger.warn(`[${label}] forwarded address not opened in ${tabId}`);
        const { kind } = error as { kind?: unknown };
        const description =
          kind === "not-connected" ? "ERR_SSH_NOT_CONNECTED" : "ERR_PORT_FORWARD_FAILED";
        this.setLoadFailure(tabId, entry, { url, description });
        for (const listener of this.refusedListeners) listener(tabId, url, error);
      },
    );
  }

  destroy(args: { tabId: string }): void {
    const { tabId } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[destroy] unknown tabId: ${tabId}`);
      return;
    }

    if (this.permissionDeps) {
      const promptManager = this.permissionDeps.promptManager;
      if (!entry.view.webContents.isDestroyed()) {
        promptManager.disposeByWebContents(entry.view.webContents.id);
      }
    }

    if (entry.devtoolsView !== null) {
      try {
        entry.win.contentView.removeChildView(entry.devtoolsView);
      } catch {}
      if (!entry.devtoolsView.webContents.isDestroyed()) {
        entry.devtoolsView.webContents.close();
      }
      entry.devtoolsView = null;
      entry.devtoolsOpen = false;
    }

    try {
      entry.win.contentView.removeChildView(entry.view);
    } catch (err) {
      logger.warn(`[destroy] removeChildView failed for ${tabId}: ${(err as Error).message}`);
    }

    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }

    this.tabs.delete(tabId);
    this.snapshotTabs.delete(tabId);
    logger.debug(`[destroy] tab ${tabId} destroyed`);
  }

  get(tabId: string): Readonly<TabEntry> | undefined {
    return this.tabs.get(tabId);
  }

  setBounds(args: CssBounds & { tabId: string }): void {
    const { tabId, x, y, width, height } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setBounds] unknown tabId: ${tabId}`);
      return;
    }

    if (width <= 0 || height <= 0) {
      return;
    }

    entry.lastBounds = { x, y, width, height };

    this.applyCssBounds(entry, entry.view, entry.lastBounds);
  }

  private applyCssBounds(entry: TabEntry, view: WebContentsView, b: CssBounds): void {
    const zf = entry.win.webContents.getZoomFactor();
    view.setBounds({
      x: Math.round(b.x * zf),
      y: Math.round(b.y * zf),
      width: Math.round(b.width * zf),
      height: Math.round(b.height * zf),
    });
  }

  setActive(args: { tabId: string; active: boolean }): void {
    const { tabId, active } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setActive] unknown tabId: ${tabId}`);
      return;
    }

    if (entry.active === active) return;

    if (active) {
      this.attachAndRestoreBounds(entry);
      if (entry.devtoolsOpen && entry.devtoolsView !== null) {
        this.attachAndRestoreDevtoolsBounds(entry);
      }
      entry.view.webContents.setBackgroundThrottling(false);
    } else {
      this.safeRemoveChildView(entry);
      if (entry.devtoolsOpen && entry.devtoolsView !== null) {
        this.safeRemoveDevtoolsChildView(entry);
      }
      entry.view.webContents.setBackgroundThrottling(true);
    }

    entry.active = active;
  }

  private attachAndRestoreBounds(entry: TabEntry): void {
    entry.view.setVisible(!this.isSuspended(entry) && entry.loadFailure === null);
    entry.win.contentView.addChildView(entry.view);
    const b = entry.lastBounds;
    if (b) {
      this.applyCssBounds(entry, entry.view, b);
    }
  }

  private safeRemoveChildView(entry: TabEntry): void {
    try {
      entry.win.contentView.removeChildView(entry.view);
    } catch {}
  }

  private attachAndRestoreDevtoolsBounds(entry: TabEntry): void {
    const dt = entry.devtoolsView;
    if (dt === null) return;
    dt.setVisible(!this.isSuspended(entry));
    entry.win.contentView.addChildView(dt);
    const b = entry.devtoolsBounds;
    if (b !== null) {
      this.applyCssBounds(entry, dt, b);
    }
  }

  private safeRemoveDevtoolsChildView(entry: TabEntry): void {
    if (entry.devtoolsView === null) return;
    try {
      entry.win.contentView.removeChildView(entry.devtoolsView);
    } catch {}
  }

  async suspendAll(opts: {
    captureSnapshot: boolean;
    windowId: number;
  }): Promise<SuspendSnapshot[]> {
    const { windowId } = opts;
    if (this.suspendedWindows.has(windowId)) return [];
    this.suspendedWindows.add(windowId);
    const gen = this.nextSuspendGeneration(windowId);

    const activeEntries = new Map<string, TabEntry>();
    for (const [tabId, entry] of this.tabs) {
      if (entry.windowId !== windowId) continue;
      if (entry.active && !entry.view.webContents.isDestroyed()) {
        activeEntries.set(tabId, entry);
      }
    }

    const snapshots = opts.captureSnapshot ? await this.captureActiveSnapshots(activeEntries) : [];

    if (gen !== this.suspendGenerations.get(windowId)) return [];

    for (const entry of activeEntries.values()) {
      if (!entry.active || entry.view.webContents.isDestroyed()) continue;
      entry.view.setVisible(false);
      if (
        entry.devtoolsOpen &&
        entry.devtoolsView !== null &&
        !entry.devtoolsView.webContents.isDestroyed()
      ) {
        entry.devtoolsView.setVisible(false);
      }
    }

    return snapshots.filter(({ tabId }) => {
      if (this.tabs.get(tabId) !== activeEntries.get(tabId)) return false;
      this.snapshotTabs.set(tabId, windowId);
      return true;
    });
  }

  resumeAll(windowId: number): string[] {
    if (!this.suspendedWindows.delete(windowId)) return [];
    this.nextSuspendGeneration(windowId);

    for (const entry of this.tabs.values()) {
      if (entry.windowId !== windowId) continue;
      if (entry.active && !entry.view.webContents.isDestroyed()) {
        entry.view.setVisible(entry.loadFailure === null);
        if (
          entry.devtoolsOpen &&
          entry.devtoolsView !== null &&
          !entry.devtoolsView.webContents.isDestroyed()
        ) {
          entry.devtoolsView.setVisible(true);
        }
      }
    }
    const snapshotTabs: string[] = [];
    for (const [tabId, owner] of this.snapshotTabs) {
      if (owner !== windowId) continue;
      snapshotTabs.push(tabId);
      this.snapshotTabs.delete(tabId);
    }
    return snapshotTabs;
  }

  private async captureActiveSnapshots(
    activeEntries: ReadonlyMap<string, TabEntry>,
  ): Promise<SuspendSnapshot[]> {
    const TINY_DATA_URL_THRESHOLD = 2_000;

    const captures = [...activeEntries].map(
      async ([tabId, entry]): Promise<SuspendSnapshot | null> => {
        try {
          if (entry.loadFailure) return null;
          const img = await entry.view.webContents.capturePage();
          if (img.isEmpty()) return null;
          const buf = img.toJPEG(75);
          const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
          if (dataUrl.length < TINY_DATA_URL_THRESHOLD) {
            return null;
          }
          return { tabId, dataUrl };
        } catch (err) {
          logger.warn(`[suspendAll] capturePage failed for ${tabId}: ${(err as Error).message}`);
          return null;
        }
      },
    );

    return (await Promise.all(captures)).filter((snapshot) => snapshot !== null);
  }

  navigate(args: { tabId: string; url: string }): void {
    const { tabId, url } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[navigate] unknown tabId: ${tabId}`);
      return;
    }
    this.load(tabId, entry, url, "navigate");
  }

  goBack(args: { tabId: string }): void {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[goBack] unknown tabId: ${args.tabId}`);
      return;
    }
    if (entry.view.webContents.navigationHistory.canGoBack()) {
      entry.navigationRequest++;
      entry.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(args: { tabId: string }): void {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[goForward] unknown tabId: ${args.tabId}`);
      return;
    }
    if (entry.view.webContents.navigationHistory.canGoForward()) {
      entry.navigationRequest++;
      entry.view.webContents.navigationHistory.goForward();
    }
  }

  reload(args: { tabId: string; ignoreCache?: boolean }): void {
    const { tabId, ignoreCache } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[reload] unknown tabId: ${tabId}`);
      return;
    }
    if (entry.loadFailure) {
      this.load(tabId, entry, entry.loadFailure.url, "retry");
      return;
    }
    entry.navigationRequest++;
    if (ignoreCache) {
      entry.view.webContents.reloadIgnoringCache();
    } else {
      entry.view.webContents.reload();
    }
  }

  openDevTools(args: { tabId: string }): { open: boolean } {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[openDevTools] unknown tabId: ${args.tabId}`);
      return { open: false };
    }

    if (entry.devtoolsOpen) {
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.closeDevTools();
      }
      this.safeRemoveDevtoolsChildView(entry);
      entry.devtoolsOpen = false;
      return { open: false };
    }

    if (entry.devtoolsView === null) {
      entry.devtoolsView = new WebContentsView({});
      excludeFromBroadcast(entry.devtoolsView.webContents);
    }

    if (entry.active) {
      this.attachAndRestoreDevtoolsBounds(entry);
    }

    entry.view.webContents.setDevToolsWebContents(entry.devtoolsView.webContents);
    entry.view.webContents.openDevTools({ mode: "detach" });
    entry.devtoolsOpen = true;
    return { open: true };
  }

  setDevToolsBounds(args: CssBounds & { tabId: string }): void {
    const { tabId, x, y, width, height } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setDevToolsBounds] unknown tabId: ${tabId}`);
      return;
    }

    entry.devtoolsBounds = { x, y, width, height };

    if (entry.devtoolsView !== null && !entry.devtoolsView.webContents.isDestroyed()) {
      this.applyCssBounds(entry, entry.devtoolsView, entry.devtoolsBounds);
    }
  }

  listByWorkspace(workspaceId: string): string[] {
    const result: string[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === workspaceId) {
        result.push(tabId);
      }
    }
    return result;
  }

  closePopups(workspaceId: string): void {
    this.popups.closeWorkspace(workspaceId);
  }

  disposeWindow(windowId: number): void {
    for (const [tabId, entry] of [...this.tabs]) {
      if (entry.windowId === windowId) this.destroy({ tabId });
    }
    this.suspendedWindows.delete(windowId);
    this.suspendGenerations.delete(windowId);
  }

  disposeAll(): void {
    for (const tabId of [...this.tabs.keys()]) {
      this.destroy({ tabId });
    }
    this.popups.closeAll();
  }
}
