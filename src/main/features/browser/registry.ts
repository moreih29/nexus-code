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
 *   setBounds() — resize/reposition.  Renderer sends CSS-layout pixels; we
 *                 multiply by the host webContents' zoom factor to map them
 *                 into the window's DIP space before applying (see
 *                 `applyCssBounds`).  DPR/HiDPI is handled by Chromium and
 *                 needs no conversion.
 *   suspendAll() — capture (optional) + hide every active view so DOM
 *                  overlays (modals/menus/drag indicators) can render above.
 *   resumeAll() — show every previously-active view.
 *
 * SUSPEND VS SETACTIVE
 * --------------------
 * Two independent visibility axes:
 *   active   — driven by setActive.  Tab is the active tab in its group.
 *              Controls tree attachment (addChildView / removeChildView).
 *   visible  — driven by suspendAll / resumeAll.  Controls per-view
 *              `setVisible()` for the duration of an overlay.  Decoupled so
 *              a resumeAll can restore visibility without disturbing which
 *              tab is "active".
 *
 * The view is actually drawn iff `active && !suspended`.
 *
 * VSCode REFERENCE
 * ----------------
 * The hide-and-screenshot pattern mirrors VSCode's
 * `references/vscode/src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts`
 * — capture the page first, hide afterwards, and let the renderer paint
 * the captured image where the native view used to be.
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

import type { BrowserWindow } from "electron";
import { WebContentsView } from "electron";
import { createLogger } from "../../../shared/log/main";
import { installAppScrollbarStyle } from "./page-style";
import {
  buildBrowserTabWebPreferences,
  installNavigationGuards,
  installPermissionHandler,
  type PermissionHandlerDeps,
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
  /**
   * Sibling WebContentsView that hosts the DevTools UI when DevTools is
   * open for this tab.  Lazily created on first `openDevTools` call and
   * reused across toggles (kept around once allocated — destroying and
   * recreating is wasted work; calls to `closeDevTools` only detach it
   * from the window).  Set back to `null` only on tab `destroy`.
   */
  devtoolsView: WebContentsView | null;
  /**
   * Last bounds applied via `setDevToolsBounds`.  Same role as `lastBounds`
   * — re-applied whenever the devtools view is re-attached after a
   * suspend/resume or setActive(true) cycle.
   */
  devtoolsBounds: CssBounds | null;
  /**
   * Whether DevTools is currently open and docked for this tab.  Used so
   * `openDevTools` can implement the toggle, `setActive`/suspend can mirror
   * the page-view visibility decisions onto the devtools view, and ipc.ts
   * can broadcast the right `devtoolsToggled` payload.
   */
  devtoolsOpen: boolean;
}

/**
 * CSS-layout-pixel bounds as measured by the renderer's
 * `getBoundingClientRect()`. These are pre-zoom: `applyCssBounds` multiplies
 * by the shell zoom factor to map them into the window's DIP space before
 * calling `WebContentsView.setBounds()`. (DPR/HiDPI is separate and handled
 * by Chromium.)
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

/** One snapshot result for `suspendAll` — `dataUrl` is null when capture failed. */
export interface SuspendSnapshot {
  tabId: string;
  dataUrl: string | null;
}

export class BrowserTabRegistry {
  private readonly win: BrowserWindow;
  private readonly tabs = new Map<string, TabEntry>();
  private readonly permissionDeps: PermissionHandlerDeps | undefined;
  /**
   * Global "everything is hidden right now" toggle.
   *
   * Driven by `suspendAll`/`resumeAll`.  While true, every TabEntry with
   * `active=true` is held at `setVisible(false)` so DOM overlays (dropdown
   * menus, modal dialogs, drag-to-split indicators) can paint above where
   * the browser would otherwise cover.  The renderer holds the refcount;
   * this class only sees the boolean edge.
   */
  private suspended = false;
  /**
   * Bumped at every suspendAll → snapshot capture and every resumeAll.
   * Used to bail out of a hide path when resumeAll races mid-capture.
   *
   * A capture-then-hide cycle records the generation before its `await`,
   * and skips the actual `setVisible(false)` step if the generation has
   * advanced — meaning resumeAll already ran and the view is supposed to
   * be visible.
   */
  private suspendGeneration = 0;

  constructor(win: BrowserWindow, permissionDeps?: PermissionHandlerDeps) {
    this.win = win;
    this.permissionDeps = permissionDeps;
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
  create(args: { tabId: string; workspaceId: string; url: string; partition: string }): void {
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
    installPermissionHandler(view.webContents.session, this.permissionDeps);

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

    const entry: TabEntry = {
      view,
      workspaceId,
      partition,
      active: false,
      lastBounds: null,
      devtoolsView: null,
      devtoolsBounds: null,
      devtoolsOpen: false,
    };
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

    // Notify the prompt manager so any pending permission callbacks for this
    // WebContents are denied immediately rather than leaked as stale closures.
    if (this.permissionDeps) {
      const promptManager = this.permissionDeps.promptManager;
      if (!entry.view.webContents.isDestroyed()) {
        promptManager.disposeByWebContents(entry.view.webContents.id);
      }
    }

    // Tear down the DevTools sibling view first if one was ever allocated.
    // Mirrors the page-view cleanup below — detach then close WebContents.
    if (entry.devtoolsView !== null) {
      try {
        this.win.contentView.removeChildView(entry.devtoolsView);
      } catch {
        // May already be detached (closed before destroy).
      }
      if (!entry.devtoolsView.webContents.isDestroyed()) {
        entry.devtoolsView.webContents.close();
      }
      entry.devtoolsView = null;
      entry.devtoolsOpen = false;
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
   * Coordinates are CSS-layout pixels as measured by the renderer's
   * `getBoundingClientRect()`. They are mapped into the window's DIP space by
   * `applyCssBounds` (which multiplies by the shell zoom factor) before being
   * handed to `WebContentsView.setBounds()`.
   */
  setBounds(args: CssBounds & { tabId: string }): void {
    const { tabId, x, y, width, height } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setBounds] unknown tabId: ${tabId}`);
      return;
    }

    // Guard against degenerate (zero/negative-size) bounds. The renderer can
    // briefly measure a 0×0 rect while its layout is still settling (e.g. the
    // first tab opening in an empty workspace). Applying those would collapse
    // the view to invisible and — worse — caching them would let
    // attachAndRestoreBounds() restore the collapsed geometry on the next
    // activation. Drop the update and keep the last good bounds instead; the
    // renderer re-sends valid bounds on its next ResizeObserver/reparent tick.
    if (width <= 0 || height <= 0) {
      return;
    }

    // Cache so resumeAll() can re-apply after a suspend/resume cycle —
    // Electron does not preserve bounds across removeChildView/addChildView.
    // Cached in CSS px (verbatim from the renderer) so a later re-apply picks
    // up the *current* zoom factor, not the one in effect when this arrived.
    entry.lastBounds = { x, y, width, height };

    this.applyCssBounds(entry.view, entry.lastBounds);
  }

  /**
   * Maps renderer CSS-pixel bounds to window DIP bounds and applies them to a
   * WebContentsView.
   *
   * The renderer measures placeholder geometry with `getBoundingClientRect()`,
   * which returns CSS-layout pixels — these do NOT include the host
   * webContents' zoom factor (the ⌘+ / ⌘- "zoom the whole shell" gesture).
   * A WebContentsView sibling, however, is positioned in the window's DIP
   * space, which the page paint IS scaled into by that zoom factor: an element
   * at CSS coordinate `c` with zoom factor `zf` paints at `c * zf` DIP. So we
   * must multiply by `zf` for the native view to line up with the painted
   * placeholder. Without this the view drifts toward the origin (zf > 1,
   * invading the sidebar) or away from it (zf < 1), and re-measuring never
   * helps because the renderer keeps reporting the same un-zoomed CSS values.
   *
   * NOTE: this is the *page zoom* factor, NOT devicePixelRatio. HiDPI/Retina
   * scaling is handled by Chromium internally and needs no conversion here —
   * do not conflate the two.
   *
   * Reading the factor fresh on every apply makes the whole thing
   * self-correcting: a shell-zoom change resizes the CSS viewport, which
   * resizes the placeholder, which fires the renderer's ResizeObserver and
   * re-sends bounds — re-applied here with the now-current factor.
   */
  private applyCssBounds(view: WebContentsView, b: CssBounds): void {
    const zf = this.win.webContents.getZoomFactor();
    view.setBounds({
      x: Math.round(b.x * zf),
      y: Math.round(b.y * zf),
      width: Math.round(b.width * zf),
      height: Math.round(b.height * zf),
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
      // Always attach to the contentView — the visible/hidden axis is
      // handled separately via setVisible() so suspendAll/resumeAll can
      // toggle painting without re-attaching the view.
      this.attachAndRestoreBounds(entry);
      // Mirror the attach on the devtools sibling view when DevTools is
      // open — otherwise switching to another tab and back would leave the
      // devtools view detached from the window.
      if (entry.devtoolsOpen && entry.devtoolsView !== null) {
        this.attachAndRestoreDevtoolsBounds(entry);
      }
      // If the registry is currently suspended (an overlay is in progress),
      // immediately hide the freshly-attached view so it doesn't paint above
      // the modal.  resumeAll() will call setVisible(true) once the overlay
      // closes.
      if (this.suspended && !entry.view.webContents.isDestroyed()) {
        entry.view.setVisible(false);
        if (entry.devtoolsView !== null && !entry.devtoolsView.webContents.isDestroyed()) {
          entry.devtoolsView.setVisible(false);
        }
      }
      entry.view.webContents.setBackgroundThrottling(false);
    } else {
      this.safeRemoveChildView(entry);
      // Detach the devtools sibling view too — same lifecycle axis.
      if (entry.devtoolsOpen && entry.devtoolsView !== null) {
        this.safeRemoveDevtoolsChildView(entry);
      }
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
      this.applyCssBounds(entry.view, b);
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

  /**
   * DevTools-view equivalent of `attachAndRestoreBounds`.  Caller has
   * already verified `entry.devtoolsView !== null`.
   */
  private attachAndRestoreDevtoolsBounds(entry: TabEntry): void {
    const dt = entry.devtoolsView;
    if (dt === null) return;
    this.win.contentView.addChildView(dt);
    const b = entry.devtoolsBounds;
    if (b !== null) {
      this.applyCssBounds(dt, b);
    }
  }

  /** DevTools-view equivalent of `safeRemoveChildView`. */
  private safeRemoveDevtoolsChildView(entry: TabEntry): void {
    if (entry.devtoolsView === null) return;
    try {
      this.win.contentView.removeChildView(entry.devtoolsView);
    } catch {
      // View may already be detached.
    }
  }

  // -------------------------------------------------------------------------
  // suspendAll / resumeAll — overlay-friendly visibility toggle (VSCode style)
  // -------------------------------------------------------------------------

  /**
   * Hide every currently-active WebContentsView so DOM overlays can render
   * above the area the browser would otherwise cover.
   *
   * When `captureSnapshot` is `true` the page is first captured with
   * `webContents.capturePage()`, encoded to a JPEG dataURL, and returned to
   * the caller — the caller (ipc.ts) broadcasts each snapshot so the
   * renderer can overlay it before the live view goes dark.  This is the
   * VSCode hide-and-screenshot pattern; without it the modal would render
   * over a blank area.
   *
   * When `captureSnapshot` is `false` the hide path runs synchronously
   * (sub-millisecond) — used by drag operations where any delay would block
   * `dragover` events from reaching the DOM drop targets.
   *
   * The WebContents instances are never destroyed — page state (scroll
   * position, in-progress form input, audio) is preserved.  Background
   * throttling is left untouched on purpose: a momentary overlay should not
   * starve a tab that just had its audio playing.
   *
   * Idempotent — a second call while already suspended returns an empty
   * snapshot list without re-hiding.
   *
   * RACE GUARD
   * ----------
   * `resumeAll()` may run between this method's `capturePage` and its final
   * `setVisible(false)`.  Each call snapshots the current `suspendGeneration`
   * and bails out before hiding if the generation has advanced, leaving the
   * view visible — exactly what resume requested.
   */
  async suspendAll(opts: { captureSnapshot: boolean }): Promise<SuspendSnapshot[]> {
    if (this.suspended) return [];
    this.suspended = true;
    const gen = ++this.suspendGeneration;

    const activeEntries: Array<[string, TabEntry]> = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.active && !entry.view.webContents.isDestroyed()) {
        activeEntries.push([tabId, entry]);
      }
    }

    let snapshots: SuspendSnapshot[] = [];
    if (opts.captureSnapshot) {
      snapshots = await this.captureActiveSnapshots(activeEntries);
    }

    // Bail if resumeAll ran while we were capturing — the view is supposed
    // to be visible now, hiding here would re-introduce the blank area the
    // user just dismissed.
    if (gen !== this.suspendGeneration) return [];

    for (const [, entry] of activeEntries) {
      if (entry.view.webContents.isDestroyed()) continue;
      entry.view.setVisible(false);
      // Mirror the hide onto the DevTools host view so its OS-level overlay
      // doesn't paint above a DOM modal either.
      if (
        entry.devtoolsOpen &&
        entry.devtoolsView !== null &&
        !entry.devtoolsView.webContents.isDestroyed()
      ) {
        entry.devtoolsView.setVisible(false);
      }
    }

    return snapshots;
  }

  /**
   * Re-show every WebContentsView that was active when the matching
   * `suspendAll` ran.
   *
   * Returns the list of tabIds that were re-shown — the caller broadcasts a
   * `snapshot {cleared: true}` event for each so the renderer drops its
   * cached image and exposes the live view again.
   */
  resumeAll(): string[] {
    if (!this.suspended) return [];
    this.suspended = false;
    // Bump generation so any in-flight suspendAll capture skips its hide step.
    this.suspendGeneration++;

    const resumed: string[] = [];
    for (const [tabId, entry] of this.tabs) {
      if (entry.active && !entry.view.webContents.isDestroyed()) {
        entry.view.setVisible(true);
        if (
          entry.devtoolsOpen &&
          entry.devtoolsView !== null &&
          !entry.devtoolsView.webContents.isDestroyed()
        ) {
          entry.devtoolsView.setVisible(true);
        }
        resumed.push(tabId);
      }
    }
    return resumed;
  }

  /**
   * Parallel `capturePage()` → JPEG dataURL for each active entry.
   *
   * The JPEG payload is roughly 5–10× smaller than the PNG dataURL Electron
   * returns from `nativeImage.toDataURL()`, which matters because the result
   * crosses the IPC boundary as a broadcast payload to the renderer.
   *
   * `dataUrl` is set to `null` when capture failed, returned an empty image
   * (page not yet rendered), or produced a payload too small to be a real
   * page snapshot — the renderer treats `null` as "no overlay available"
   * and keeps the existing placeholder.
   */
  private async captureActiveSnapshots(
    activeEntries: Array<[string, TabEntry]>,
  ): Promise<SuspendSnapshot[]> {
    const TINY_DATA_URL_THRESHOLD = 2_000; // ~150x150 solid-colour JPEG floor

    const captures = activeEntries.map(async ([tabId, entry]): Promise<SuspendSnapshot> => {
      try {
        const img = await entry.view.webContents.capturePage();
        if (img.isEmpty()) return { tabId, dataUrl: null };
        const buf = img.toJPEG(75);
        const dataUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
        if (dataUrl.length < TINY_DATA_URL_THRESHOLD) {
          return { tabId, dataUrl: null };
        }
        return { tabId, dataUrl };
      } catch (err) {
        logger.warn(`[suspendAll] capturePage failed for ${tabId}: ${(err as Error).message}`);
        return { tabId, dataUrl: null };
      }
    });

    return Promise.all(captures);
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

  /**
   * Toggle inline-docked DevTools for `tabId`.  Returns the new
   * `{ open }` state so the IPC layer can broadcast a `devtoolsToggled`
   * event to the renderer.
   *
   * INLINE DOCK MECHANISM
   * ---------------------
   * The DevTools UI is rendered into a sibling `WebContentsView` (allocated
   * lazily on first open and reused across toggles) that we add to the
   * window's contentView at the bounds the renderer provides via
   * `setDevToolsBounds`.  `setDevToolsWebContents` tells Chromium to render
   * the DevTools front-end into that sibling instead of opening its own
   * top-level window.
   *
   * The `mode: "detach"` flag passed to `openDevTools` is what stops
   * Chromium from also creating its default DevTools host window — it sees
   * the explicit setDevToolsWebContents wiring as the host and follows
   * that instead.
   */
  openDevTools(args: { tabId: string }): { open: boolean } {
    const entry = this.tabs.get(args.tabId);
    if (!entry) {
      logger.warn(`[openDevTools] unknown tabId: ${args.tabId}`);
      return { open: false };
    }

    if (entry.devtoolsOpen) {
      // Close: drop the DevTools front-end and detach the host view from
      // the window.  The WebContentsView and its WebContents are KEPT so
      // the next open can reuse the same host (cheaper than re-allocating).
      if (!entry.view.webContents.isDestroyed()) {
        entry.view.webContents.closeDevTools();
      }
      this.safeRemoveDevtoolsChildView(entry);
      entry.devtoolsOpen = false;
      return { open: false };
    }

    // Open path — lazily allocate the host view.
    if (entry.devtoolsView === null) {
      entry.devtoolsView = new WebContentsView({});
    }

    // Attach the host view to the window when the tab is currently active.
    // If the tab is inactive (background) the renderer will not be sending
    // bounds yet — that's fine, attach lazily on the next setActive(true).
    if (entry.active) {
      this.attachAndRestoreDevtoolsBounds(entry);
      // Mirror the suspend state — a global suspendAll may be in progress
      // when the user opens DevTools (unlikely but harmless to handle).
      if (this.suspended && !entry.devtoolsView.webContents.isDestroyed()) {
        entry.devtoolsView.setVisible(false);
      }
    }

    entry.view.webContents.setDevToolsWebContents(entry.devtoolsView.webContents);
    entry.view.webContents.openDevTools({ mode: "detach" });
    entry.devtoolsOpen = true;
    return { open: true };
  }

  /**
   * Resize/reposition the DevTools host WebContentsView for `tabId`.
   *
   * Coordinates follow the same DIP convention as `setBounds`.  Cached on
   * the entry so setActive(true) can re-apply them on re-attach.  When
   * DevTools is currently closed for the tab, the bounds are cached but
   * not applied — the next openDevTools call will use them.
   */
  setDevToolsBounds(args: CssBounds & { tabId: string }): void {
    const { tabId, x, y, width, height } = args;
    const entry = this.tabs.get(tabId);
    if (!entry) {
      logger.warn(`[setDevToolsBounds] unknown tabId: ${tabId}`);
      return;
    }

    entry.devtoolsBounds = { x, y, width, height };

    if (entry.devtoolsView !== null && !entry.devtoolsView.webContents.isDestroyed()) {
      this.applyCssBounds(entry.devtoolsView, entry.devtoolsBounds);
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
