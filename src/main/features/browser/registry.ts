/**
 * BrowserTabRegistry — owns every WebContentsView that backs an embedded
 * browser tab in the main window.
 *
 * LIFECYCLE
 * ---------
 *   create()   — allocates a detached WebContentsView and applies security policy.
 *   destroy()  — closes the WebContents, detaches the view, removes the entry.
 *   setActive() — attach (active=true) or detach (active=false) the view.
 *   setBounds() — resize/reposition.  Renderer sends CSS-layout pixels; we
 *                 multiply by the host webContents' zoom factor to map them
 *                 into the window's DIP space before applying (see
 *                 `applyCssBounds`).  DPR/HiDPI is handled by Chromium and
 *                 needs no conversion.
 *   suspendAll() — capture (optional) + hide every active view so DOM
 *                  overlays (modals/menus/drag indicators) can render above.
 *   resumeAll() — show every currently active view and clear snapshots.
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

// ---------------------------------------------------------------------------
// Internal data types
// ---------------------------------------------------------------------------

export type BrowserHostWindow = Pick<BrowserWindow, "contentView" | "webContents">;

interface TabEntry {
  view: WebContentsView;
  readonly win: BrowserHostWindow;
  readonly windowId: number;
  workspaceId: string;
  partition: string;
  loadFailure: BrowserLoadFailure | null;
  navigationRequest: number;
  forwardedAddress: { requested: string; target: string } | null;
  /**
   * Whether this tab is the active tab in its group.
   *
   * Active views stay attached while an overlay temporarily hides them.
   */
  active: boolean;
  /**
   * Last CSS bounds applied via setBounds(), restored on reattach.
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
   * setActive(true) or DevTools toggle.
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

/**
 * Turns a URL a workspace's tab is to load into the one it loads: an SSH
 * workspace's local address goes to its port forward (pty/forwards.ts).
 */
export interface BrowserAddressResolver {
  /** Whether `url` loads as another URL in the workspace's tabs; answered at once. */
  rewrites(workspaceId: string, url: string): boolean;
  /** The URL to load for `url`; rejects with why it cannot be opened. */
  resolve(workspaceId: string, url: string): Promise<string>;
}

export interface BrowserLoadFailure {
  url: string;
  description: string;
}

/** A usable page snapshot captured by `suspendAll`. */
interface SuspendSnapshot {
  tabId: string;
  dataUrl: string;
}

export class BrowserTabRegistry {
  private readonly tabs = new Map<string, TabEntry>();
  private readonly popups = new PopupTracker();
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
  private readonly suspendedWindows = new Set<number>();
  /**
   * Bumped at every suspendAll → snapshot capture and every resumeAll.
   * Used to bail out of a hide path when resumeAll races mid-capture.
   *
   * A capture-then-hide cycle records the generation before its `await`,
   * and skips the actual `setVisible(false)` step if the generation has
   * advanced — meaning resumeAll already ran and the view is supposed to
   * be visible.
   */
  private readonly suspendGenerations = new Map<number, number>();
  /** Tabs whose overlay snapshot needs clearing on resume, even after detaching. */
  private readonly snapshotTabs = new Map<string, number>();
  /** Told of each tab's WebContents as it is created, before its first page loads. */
  private readonly createListeners = new Set<(tabId: string, contents: WebContents) => void>();
  private addressResolver: BrowserAddressResolver | null = null;
  /** Told of a URL the resolver would not open, and why. */
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

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  /**
   * Creates a detached WebContentsView for `tabId` and navigates it to `url`.
   *
   * If a view for `tabId` already exists it is destroyed before the new one
   * is created — see class doc for the rationale.
   */
  create(args: {
    tabId: string;
    workspaceId: string;
    url: string;
    partition: string;
    win: BrowserHostWindow;
  }): void {
    const { tabId, workspaceId, url, partition, win } = args;

    // Guard: if an entry already exists, tear it down cleanly first.
    if (this.tabs.has(tabId)) {
      logger.warn(`[create] tabId ${tabId} already exists — destroying and recreating`);
      this.destroy({ tabId });
    }

    const webPreferences = buildBrowserTabWebPreferences(partition);
    const view = new WebContentsView({ webPreferences });

    // Install permission handler on the dedicated session so each workspace
    // partition gets its own deny-by-default permission policy.  The
    // workspaceId is bound here (not derived from the session) because Electron
    // does not expose the partition string on the Session object.
    installPermissionHandler(view.webContents.session, this.permissionDeps, workspaceId);
    installLocalFileReadGuard(view.webContents);

    // Wire navigation guards.  The onNavigate callback is intentionally
    // stubbed here; callers (ipc.ts) attach broadcast callbacks by listening
    // to the WebContents events directly after create() returns.
    installNavigationGuards(view.webContents, undefined, (popup) =>
      this.popups.track(workspaceId, popup),
    );

    // Replace the native Chromium scrollbar with our app-wide thin scrollbar
    // style on every page load.  Independent of navigation security — purely
    // visual — so it lives in its own module.
    installAppScrollbarStyle(view.webContents);

    // A tab not shown is in no window; on macOS its dialogs would hold up
    // the whole app until clicked.
    showDialogsOverWindow(view.webContents, () => win as BrowserWindow);

    // Start the view in the inactive (detached) state.  The caller must call
    // setActive(true) + setBounds() to make it visible.  Background throttling
    // is enabled from the start to conserve resources until the tab is shown.
    view.webContents.setBackgroundThrottling(true);

    const entry: TabEntry = {
      view,
      win,
      windowId: win.webContents.id,
      workspaceId,
      partition,
      loadFailure: null,
      navigationRequest: 0,
      forwardedAddress: null,
      active: false,
      lastBounds: null,
      devtoolsView: null,
      devtoolsBounds: null,
      devtoolsOpen: false,
    };
    this.tabs.set(tabId, entry);
    view.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // ERR_ABORTED
      const forward = entry.forwardedAddress;
      this.setLoadFailure(tabId, entry, {
        url: forward?.target === url ? forward.requested : url,
        description,
      });
    });
    view.webContents.on("did-navigate", () => this.setLoadFailure(tabId, entry, null));
    for (const listener of this.createListeners) listener(tabId, view.webContents);

    // A page's own move to a local address of an SSH workspace goes to the
    // address's forward instead. Guards that blocked it already win.
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

    // Begin loading the initial URL.  Will-navigate guards are already wired.
    this.load(tabId, entry, url, "create");

    logger.debug(`[create] tab ${tabId} created (partition=${partition})`);
  }

  /**
   * Calls `listener` with each tab's WebContents as it is created, before its
   * first page loads, so it can watch the tab from the start. Returns the
   * call that stops it.
   */
  onCreate(listener: (tabId: string, contents: WebContents) => void): () => void {
    this.createListeners.add(listener);
    return () => this.createListeners.delete(listener);
  }

  setAddressResolver(resolver: BrowserAddressResolver | null): void {
    this.addressResolver = resolver;
  }

  /** Calls `listener` with each URL the address resolver would not open. */
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

  /** Loads `url` in the tab, through the address resolver when it has a say. */
  private load(tabId: string, entry: TabEntry, url: string, label: string): void {
    const request = ++entry.navigationRequest;
    entry.forwardedAddress = null;
    if (!isTabLoadAllowed(url)) {
      logger.warn(`[${label}] disallowed address in ${tabId}`);
      this.setLoadFailure(tabId, entry, { url, description: "ERR_DISALLOWED_URL_SCHEME" });
      return;
    }
    const loadNow = (target: string) => {
      entry.view.webContents.loadURL(target).catch(() => {
        logger.warn(`[${label}] loadURL failed for ${tabId}`);
      });
    };
    const resolver = this.addressResolver;
    if (!resolver?.rewrites(entry.workspaceId, url)) {
      loadNow(url);
      return;
    }
    const isCurrent = () =>
      this.tabs.get(tabId) === entry &&
      entry.navigationRequest === request &&
      !entry.view.webContents.isDestroyed();
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
        entry.win.contentView.removeChildView(entry.devtoolsView);
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
      entry.win.contentView.removeChildView(entry.view);
    } catch (err) {
      // The view may already have been removed (e.g. window close race).
      logger.warn(`[destroy] removeChildView failed for ${tabId}: ${(err as Error).message}`);
    }

    // Close the WebContents to release renderer process resources.
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }

    this.tabs.delete(tabId);
    this.snapshotTabs.delete(tabId);
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

    // Keep CSS pixels so reattachment uses the current shell zoom factor.
    entry.lastBounds = { x, y, width, height };

    this.applyCssBounds(entry, entry.view, entry.lastBounds);
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
  private applyCssBounds(entry: TabEntry, view: WebContentsView, b: CssBounds): void {
    const zf = entry.win.webContents.getZoomFactor();
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
   * Active   → view is added to the main window's contentView and follows
   *             the current suspend state. Background throttling is disabled.
   * Inactive → view is removed from the main window's contentView, background
   *             throttling is enabled to conserve CPU/GPU resources.
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
    // An overlay may have ended while the view was detached.
    entry.view.setVisible(!this.isSuspended(entry) && entry.loadFailure === null);
    entry.win.contentView.addChildView(entry.view);
    const b = entry.lastBounds;
    if (b) {
      this.applyCssBounds(entry, entry.view, b);
    }
  }

  /**
   * removeChildView that swallows the "already removed" race window — the
   * view may have been detached implicitly by a window close or a prior
   * suspend cycle.
   */
  private safeRemoveChildView(entry: TabEntry): void {
    try {
      entry.win.contentView.removeChildView(entry.view);
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
    dt.setVisible(!this.isSuspended(entry));
    entry.win.contentView.addChildView(dt);
    const b = entry.devtoolsBounds;
    if (b !== null) {
      this.applyCssBounds(entry, dt, b);
    }
  }

  /** DevTools-view equivalent of `safeRemoveChildView`. */
  private safeRemoveDevtoolsChildView(entry: TabEntry): void {
    if (entry.devtoolsView === null) return;
    try {
      entry.win.contentView.removeChildView(entry.devtoolsView);
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

    // Bail if resumeAll ran while we were capturing — the view is supposed
    // to be visible now, hiding here would re-introduce the blank area the
    // user just dismissed.
    if (gen !== this.suspendGenerations.get(windowId)) return [];

    for (const entry of activeEntries.values()) {
      if (!entry.active || entry.view.webContents.isDestroyed()) continue;
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

    return snapshots.filter(({ tabId }) => {
      if (this.tabs.get(tabId) !== activeEntries.get(tabId)) return false;
      this.snapshotTabs.set(tabId, windowId);
      return true;
    });
  }

  /**
   * Re-show currently attached views and return the IDs of all tabs with
   * snapshots to clear, including tabs that detached during the overlay.
   */
  resumeAll(windowId: number): string[] {
    if (!this.suspendedWindows.delete(windowId)) return [];
    // Bump generation so any in-flight suspendAll capture skips its hide step.
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

  /**
   * Parallel `capturePage()` → JPEG dataURL for each active entry.
   *
   * The JPEG payload is roughly 5–10× smaller than the PNG dataURL Electron
   * returns from `nativeImage.toDataURL()`, which matters because the result
   * crosses the IPC boundary as a broadcast payload to the renderer.
   *
   * Failed, empty, and very small captures leave the existing placeholder visible.
   */
  private async captureActiveSnapshots(
    activeEntries: ReadonlyMap<string, TabEntry>,
  ): Promise<SuspendSnapshot[]> {
    const TINY_DATA_URL_THRESHOLD = 2_000; // ~150x150 solid-colour JPEG floor

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

  // -------------------------------------------------------------------------
  // Navigation helpers
  // -------------------------------------------------------------------------

  /**
   * Navigates the tab to `url`: loadURL skips will-navigate, so load()
   * refuses a scheme a tab does not open (isTabLoadAllowed).
   */
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
      excludeFromBroadcast(entry.devtoolsView.webContents);
    }

    // Attach the host view to the window when the tab is currently active.
    // If the tab is inactive (background) the renderer will not be sending
    // bounds yet — that's fine, attach lazily on the next setActive(true).
    if (entry.active) {
      this.attachAndRestoreDevtoolsBounds(entry);
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
      this.applyCssBounds(entry, entry.devtoolsView, entry.devtoolsBounds);
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
   * Closes every popup opened from `workspaceId`'s tabs. Called when the
   * workspace is removed, before its partition storage is cleared.
   */
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
