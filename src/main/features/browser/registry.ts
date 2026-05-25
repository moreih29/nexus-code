/**
 * BrowserTabRegistry — owns every WebContentsView that backs an embedded
 * browser tab in the main window.
 *
 * LIFECYCLE
 * ---------
 *   create()   — allocates a WebContentsView, applies security policy, and
 *                attaches it to the main window's contentView.
 *   destroy()  — closes the WebContents, detaches the view, removes the entry.
 *   setActive() — attach (active=true) or detach (active=false) the view.
 *   setBounds() — resize/reposition.  Coordinates are CSS pixels (DIPs) on
 *                 every platform — `WebContentsView.setBounds()` uses the
 *                 same coordinate system as the window's contentView, which
 *                 Chromium handles in DIPs.  No DPR conversion happens here.
 *
 * DUPLICATE CREATE
 * ----------------
 * If create() is called for a tabId that already exists the OLD view is
 * destroyed first and a fresh one is created.  Rationale: a duplicate call
 * means the renderer has lost track of the old view (e.g. hot-reload or a
 * workspace re-open) and wants a clean slate — silently reusing the existing
 * view would leave stale event listeners and the wrong URL loaded.
 *
 * THREAD SAFETY
 * -------------
 * All methods must be called from the main process (Electron main thread).
 * No cross-thread access is expected; the Map is not guarded by locks.
 */

import { WebContentsView } from "electron";
import type { BrowserWindow } from "electron";
import { createLogger } from "../../../shared/log/main";
import { installAppScrollbarStyle } from "./page-style";
import {
  buildBrowserTabWebPreferences,
  installNavigationGuards,
  installPermissionHandler,
} from "./security";

const logger = createLogger("browser-registry");

// ---------------------------------------------------------------------------
// Internal data types
// ---------------------------------------------------------------------------

interface TabEntry {
  view: WebContentsView;
  workspaceId: string;
  partition: string;
  /**
   * Whether this tab is the active tab in its group.
   *
   * The view is actually attached to the window iff `active && !registry.suspended`.
   * Decoupling these two flags lets the global suspendAll/resumeAll cycle
   * detach every active view temporarily without losing the per-tab activation
   * state we restore on resume.
   */
  active: boolean;
  /**
   * Last bounds applied via setBounds().  Cached so resumeAll() can re-apply
   * them after re-attaching — Electron does NOT preserve bounds across
   * remove/addChildView pairs.
   */
  lastBounds: CssBounds | null;
}

/**
 * The CSS-coordinate bounds (DIPs) as sent by the renderer.
 *
 * Electron's `WebContentsView.setBounds()` accepts these coordinates verbatim
 * — the window's contentView is itself laid out in DIPs on every platform —
 * so no devicePixelRatio conversion is performed.
 */
export interface CssBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class BrowserTabRegistry {
  private readonly win: BrowserWindow;
  private readonly tabs = new Map<string, TabEntry>();
  /**
   * Global "everything is hidden right now" toggle.
   *
   * Driven by `suspendAll`/`resumeAll`.  While true, every TabEntry with
   * `active=true` is forcibly detached from the window so DOM overlays
   * (dropdown menus, modal dialogs, drag-to-split indicators) can paint above
   * the area the browser would otherwise cover.  The renderer holds the
   * refcount; this class only sees the boolean edge.
   */
  private suspended = false;

  constructor(win: BrowserWindow) {
    this.win = win;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Creates a new WebContentsView for `tabId`, navigates it to `url`, and
   * adds it (hidden initially) to the main window's contentView hierarchy.
   *
   * If a view for `tabId` already exists it is destroyed before the new one
   * is created — see class doc for the rationale.
   */
  create(args: {
    tabId: string;
    workspaceId: string;
    url: string;
    partition: string;
  }): void {
    const { tabId, workspaceId, url, partition } = args;

    // Guard: if an entry already exists, tear it down cleanly first.
    if (this.tabs.has(tabId)) {
      logger.warn(`[create] tabId ${tabId} already exists — destroying and recreating`);
      this.destroy({ tabId });
    }

    const webPreferences = buildBrowserTabWebPreferences(partition);
    const view = new WebContentsView({ webPreferences });

    // Install permission handler on the dedicated session so each workspace
    // partition gets its own deny-by-default permission policy.
    installPermissionHandler(view.webContents.session);

    // Wire navigation guards.  The onNavigate callback is intentionally
    // stubbed here; callers (ipc.ts) attach broadcast callbacks by listening
    // to the WebContents events directly after create() returns.
    installNavigationGuards(view.webContents);

    // Replace the native Chromium scrollbar with our app-wide thin scrollbar
    // style on every page load.  Independent of navigation security — purely
    // visual — so it lives in its own module.
    installAppScrollbarStyle(view.webContents);

    // Start the view in the inactive (detached) state.  The caller must call
    // setActive(true) + setBounds() to make it visible.  Background throttling
    // is enabled from the start to conserve resources until the tab is shown.
    view.webContents.setBackgroundThrottling(true);

    const entry: TabEntry = { view, workspaceId, partition, active: false, lastBounds: null };
    this.tabs.set(tabId, entry);

    // Begin loading the initial URL.  Will-navigate guards are already wired.
    view.webContents.loadURL(url).catch((err: Error) => {
      logger.warn(`[create] initial loadURL failed for ${tabId}: ${err.message}`);
    });

    logger.debug(`[create] tab ${tabId} created (partition=${partition})`);
  }

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  /**
   * Releases all resources for `tabId`:
   *   1. Detaches the view from the main window's contentView.
   *   2. Closes the underlying WebContents.
   *   3. Removes the entry from the registry.
   *
   * No-op if `tabId` is unknown.
   */
  destroy(args: { tabId: string }): void {
    const { tabId } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[destroy] unknown tabId: ${tabId}`);
      return;
    }

    // Detach from the window's view hierarchy.
    try {
      this.win.contentView.removeChildView(entry.view);
    } catch (err) {
      // The view may already have been removed (e.g. window close race).
      logger.warn(`[destroy] removeChildView failed for ${tabId}: ${(err as Error).message}`);
    }

    // Close the WebContents to release renderer process resources.
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }

    this.tabs.delete(tabId);
    logger.debug(`[destroy] tab ${tabId} destroyed`);
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  /**
   * Returns the TabEntry for `tabId`, or `undefined` if not found.
   * Exposed for consumers that need direct access to the view or metadata.
   */
  get(tabId: string): Readonly<TabEntry> | undefined {
    return this.tabs.get(tabId);
  }

  // -------------------------------------------------------------------------
  // setBounds
  // -------------------------------------------------------------------------

  /**
   * Resizes and repositions the view.
   *
   * Coordinates are CSS pixels (DIPs) as measured by the renderer's
   * `getBoundingClientRect()`. `WebContentsView.setBounds()` consumes the
   * same coordinate system that the parent BrowserWindow uses for its
   * contentView, which Chromium lays out in DIPs on every platform — so no
   * devicePixelRatio multiplication is required here.
   *
   * `Math.round` collapses fractional sub-pixel values to integer DIPs,
   * matching what `setBounds` accepts.
   */
  setBounds(args: CssBounds & { tabId: string }): void {
    const { tabId, x, y, width, height } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setBounds] unknown tabId: ${tabId}`);
      return;
    }

    // Cache so resumeAll() can re-apply after a suspend/resume cycle —
    // Electron does not preserve bounds across removeChildView/addChildView.
    entry.lastBounds = { x, y, width, height };

    entry.view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  }

  // -------------------------------------------------------------------------
  // setActive
  // -------------------------------------------------------------------------

  /**
   * Activates or deactivates the view for `tabId`.
   *
   * Active   → view is added to the main window's contentView (unless the
   *             registry is currently suspended), background throttling is
   *             disabled so animations stay smooth.
   * Inactive → view is removed from the main window's contentView, background
   *             throttling is enabled to conserve CPU/GPU resources.
   *
   * The actual attachment depends on `active && !this.suspended` — during a
   * global suspend window (open dropdown / modal / drag) every active view is
   * detached on the registry side without disturbing the per-tab `active`
   * flag, so `resumeAll` can restore exactly the same set.
   */
  setActive(args: { tabId: string; active: boolean }): void {
    const { tabId, active } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setActive] unknown tabId: ${tabId}`);
      return;
    }

    if (entry.active === active) return; // no-op

    if (active) {
      // While suspended we record the desired state but don't actually attach.
      // resumeAll() will pick this entry up and addChildView at that point.
      if (!this.suspended) {
        this.attachAndRestoreBounds(entry);
      }
      entry.view.webContents.setBackgroundThrottling(false);
    } else {
      this.safeRemoveChildView(entry);
      entry.view.webContents.setBackgroundThrottling(true);
    }

    entry.active = active;
  }

  /**
   * `addChildView` followed by re-applying the cached `lastBounds`.  Electron
   * resets a WebContentsView's geometry on every addChildView, so without this
   * the view would reappear at (0, 0) sized 0×0.
   */
  private attachAndRestoreBounds(entry: TabEntry): void {
    this.win.contentView.addChildView(entry.view);
    const b = entry.lastBounds;
    if (b) {
      entry.view.setBounds({
        x: Math.round(b.x),
        y: Math.round(b.y),
        width: Math.round(b.width),
        height: Math.round(b.height),
      });
    }
  }

  /**
   * removeChildView that swallows the "already removed" race window — the
   * view may have been detached implicitly by a window close or a prior
   * suspend cycle.
   */
  private safeRemoveChildView(entry: TabEntry): void {
    try {
      this.win.contentView.removeChildView(entry.view);
    } catch {
      // View may already be detached.
    }
  }

  // -------------------------------------------------------------------------
  // suspendAll / resumeAll — global overlay-friendly visibility toggle
  // -------------------------------------------------------------------------

  /**
   * Detach every currently-active WebContentsView from the window's
   * contentView so DOM overlays (dropdown menus, modal dialogs, drag-to-split
   * indicators) can render above where the browser would otherwise paint.
   *
   * The WebContents instances are NOT destroyed — page state (scroll
   * position, in-progress form input, audio) is preserved.  Background
   * throttling is left untouched on purpose: a momentary overlay should not
   * starve a tab that just had its audio playing.
   *
   * Pair every `suspendAll` with a matching `resumeAll`.  The renderer holds
   * the refcount; calling `suspendAll` twice in a row is idempotent on this
   * side (the second call is a no-op).
   */
  suspendAll(): void {
    if (this.suspended) return;
    this.suspended = true;
    for (const entry of this.tabs.values()) {
      if (entry.active) {
        this.safeRemoveChildView(entry);
      }
    }
  }

  /**
   * Re-attach every WebContentsView that was active when the matching
   * `suspendAll` ran, and re-apply each view's cached bounds so it lands in
   * exactly the same position as before — Electron does not preserve bounds
   * across remove/addChildView.
   */
  resumeAll(): void {
    if (!this.suspended) return;
    this.suspended = false;
    for (const entry of this.tabs.values()) {
      if (entry.active) {
        this.attachAndRestoreBounds(entry);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  /**
   * Navigates the tab to `url`.  Will-navigate guards are already installed,
   * so navigation to non-http/https URLs will be silently blocked.
   */
  navigate(args: { tabId: string; url: string }): void {
    const { tabId, url } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[navigate] unknown tabId: ${tabId}`);
      return;
    }
    entry.view.webContents.loadURL(url).catch((err: Error) => {
      logger.warn(`[navigate] loadURL failed for ${tabId}: ${err.message}`);
    });
  }

  goBack(args: { tabId: string }): void {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[goBack] unknown tabId: ${args.tabId}`);
      return;
    }
    if (entry.view.webContents.navigationHistory.canGoBack()) {
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
    if (ignoreCache) {
      entry.view.webContents.reloadIgnoringCache();
    } else {
      entry.view.webContents.reload();
    }
  }

  openDevTools(args: { tabId: string }): void {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[openDevTools] unknown tabId: ${args.tabId}`);
      return;
    }
    if (!entry.view.webContents.isDevToolsOpened()) {
      entry.view.webContents.openDevTools({ mode: "detach" });
    } else {
      entry.view.webContents.closeDevTools();
    }
  }

  // -------------------------------------------------------------------------
  // Workspace-scoped query
  // -------------------------------------------------------------------------

  /**
   * Returns the tab IDs belonging to `workspaceId`.
   * Used by the browser closer to enumerate views that must be destroyed when
   * a workspace is removed.
   */
  listByWorkspace(workspaceId: string): string[] {
    const result: string[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === workspaceId) {
        result.push(tabId);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Destroys all registered tabs.  Called when the main window is closed.
   */
  disposeAll(): void {
    for (const tabId of [...this.tabs.keys()]) {
      this.destroy({ tabId });
    }
  }
}
