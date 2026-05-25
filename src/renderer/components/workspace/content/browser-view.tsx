/**
 * BrowserTabView — renderer-side shell for an embedded browser tab.
 *
 * ARCHITECTURE
 * ------------
 * The actual web content is rendered by a WebContentsView managed on the main
 * process side (T19 BrowserTabRegistry). This component:
 *   1. Sends `browser.create` IPC on mount.
 *   2. Renders a full-size placeholder <div> and uses ResizeObserver to track
 *      its CSS bounds, then sends `browser.setBounds` via a rAF-coalesced
 *      callback so the main process can position/resize the WebContentsView.
 *   3. Sends `browser.setActive` on active/inactive transitions so main can
 *      attach/detach the view from the BrowserWindow.
 *   4. Sends `browser.destroy` + calls `removeRuntime` on unmount.
 *
 * The component subscribes to `useBrowserRuntimeStore` for the live URL,
 * back/forward availability, loading state, and DevTools docked state, then
 * renders a toolbar (NavControls + UrlBar + DevTools toggle) and the
 * placeholder with an optional empty state.
 *
 * INLINE DOCKED DEVTOOLS
 * ----------------------
 * When `devtoolsOpen` is true, the content area splits into:
 *   - page region   (flex-1, top)
 *   - splitter      (3px drag handle)
 *   - devtools region (fixed height, user-resizable via splitter)
 *
 * A second placeholder <div> drives a second `setDevToolsBounds` IPC; main
 * positions the sibling DevTools WebContentsView at those bounds.  Both
 * placeholders share one ResizeObserver and one rAF id — they live inside the
 * same content container so any layout change pushes a single coalesced
 * update.
 *
 * RESIZE / rAF COALESCE PATTERN
 * ------------------------------
 * Mirrors the `useModelSource` rAF pattern in editor-view.tsx. A ResizeObserver
 * fires synchronously during layout — we must not call IPC synchronously from
 * an observer callback. Instead we schedule a requestAnimationFrame and cancel
 * any pending frame before scheduling a new one. This collapses rapid consecutive
 * resize events into a single IPC call per paint cycle.
 *
 * KEYBOARD SHORTCUTS (active only when this browser tab is the active tab)
 * -------------------------------------------------------------------------
 *   ⌘L        → focus URL bar + select all
 *   ⌘R        → reload
 *   ⌘⇧R       → hard reload (ignoreCache: true)
 *   ⌘[        → go back
 *   ⌘]        → go forward
 *   ⌘⌥I       → toggle DevTools (inline docked)
 */
import { Wrench } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserEmptyState } from "@/components/editor/browser/empty-state";
import { NavControls } from "@/components/editor/browser/nav-controls";
import { UrlBar } from "@/components/editor/browser/url-bar";
import { ipcCallResult } from "@/ipc/client";
import { resolveInitialBrowserUrl } from "@/state/operations/browser";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { cn } from "@/utils/cn";

interface BrowserTabViewProps {
  tabId: string;
  workspaceId: string;
  /** Initial URL from tab props (empty string for a new blank tab). */
  initialUrl: string;
  /**
   * The last committed URL from persisted tab props.
   * When empty (""), the empty state is shown until the user navigates.
   */
  lastUrl: string;
  /** Chromium partition string (e.g. `persist:browser-{workspaceId}`). */
  partition: string;
  /** Whether this browser tab is currently the active tab in its group. */
  isActive: boolean;
}

/**
 * BLANK_TAB_URL — the URL passed to browser.create when no initialUrl is set.
 *
 * `about:blank` satisfies the IPC contract's `z.string().url()` requirement
 * and is safe to load in Electron (allowed in frame-navigation guards). The
 * renderer shows the empty state overlay as long as no real URL has been
 * committed, so the blank page is never visible to the user.
 */
const BLANK_TAB_URL = "about:blank";

/**
 * Default height for the inline DevTools region (CSS pixels).  User can drag
 * the splitter to resize; state is per-tab-mount (resets on tab close).
 */
const DEFAULT_DEVTOOLS_HEIGHT = 280;
/** Minimum DevTools panel height.  Below this the splitter handle is hard to grab. */
const MIN_DEVTOOLS_HEIGHT = 120;
/** Minimum page region height that the splitter drag will preserve. */
const MIN_PAGE_HEIGHT = 100;

export function BrowserTabView({
  tabId,
  workspaceId,
  initialUrl,
  lastUrl,
  partition,
  isActive,
}: BrowserTabViewProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const devtoolsPlaceholderRef = useRef<HTMLDivElement>(null);
  // rAF id for coalesced setBounds + setDevToolsBounds calls — one rAF
  // updates both regions so a splitter drag still emits a single IPC pair
  // per paint cycle.
  const rafIdRef = useRef<number | null>(null);
  // URL bar focus imperative trigger — incrementing causes UrlBar to focus+select.
  const [urlFocusToken, setUrlFocusToken] = useState(0);
  // Whether browser.create has been sent for this tabId.
  const createdRef = useRef(false);
  // User-controlled height of the inline DevTools region.  Per-tab-mount;
  // does not survive a tab close.
  const [devtoolsHeight, setDevtoolsHeight] = useState(DEFAULT_DEVTOOLS_HEIGHT);

  // Runtime state from main-process events.
  const runtime = useBrowserRuntimeStore((s) => s.runtimes.get(tabId));
  const currentUrl = runtime?.currentUrl ?? lastUrl;
  const canGoBack = runtime?.canGoBack ?? false;
  const canGoForward = runtime?.canGoForward ?? false;
  const isLoading = runtime?.isLoading ?? false;
  // Page snapshot painted as an absolute overlay while the native view is
  // hidden by a suspendAll cycle.  When set, it shows the last frame of the
  // page captured by main right before `setVisible(false)` — letting a
  // modal/dropdown render above a still image rather than a blank area.
  // Cleared back to null when `resumeAll` broadcasts a `cleared` event.
  const snapshot = runtime?.snapshot ?? null;
  // Whether DevTools is currently docked inside the tab area.  Drives the
  // splitter region and the toolbar toggle button's active style.
  const devtoolsOpen = runtime?.devtoolsOpen ?? false;

  // Empty state: show when no real URL has been committed for this tab.
  // `about:blank` is used as the synthetic initial load and is treated as
  // "no real content" for display purposes. Once the user navigates to an
  // http/https URL the empty state disappears.
  const showEmptyState =
    (currentUrl === "" || currentUrl === BLANK_TAB_URL) && lastUrl === "";

  // -------------------------------------------------------------------------
  // Mount: browser.create
  // -------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabId/workspaceId/partition are stable for lifetime
  useEffect(() => {
    if (createdRef.current) return;
    createdRef.current = true;

    const url = resolveInitialBrowserUrl({ initialUrl, lastUrl, partition }) ?? BLANK_TAB_URL;
    void ipcCallResult("browser", "create", {
      tabId,
      workspaceId,
      url,
      partition,
    });

    // Unmount: browser.destroy + remove runtime entry.
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      void ipcCallResult("browser", "destroy", { tabId });
      useBrowserRuntimeStore.getState().removeRuntime(tabId);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Active state: browser.setActive
  // -------------------------------------------------------------------------
  useEffect(() => {
    void ipcCallResult("browser", "setActive", { tabId, active: isActive });
  }, [tabId, isActive]);

  // -------------------------------------------------------------------------
  // ResizeObserver → rAF-coalesced setBounds + setDevToolsBounds
  // -------------------------------------------------------------------------
  const sendBounds = useCallback(() => {
    rafIdRef.current = null;

    const pageEl = placeholderRef.current;
    if (pageEl !== null) {
      const rect = pageEl.getBoundingClientRect();
      // Bounds are CSS pixels (DIPs).  WebContentsView.setBounds() on the main
      // side consumes the same DIP coordinate system that the BrowserWindow's
      // contentView is laid out in, so no devicePixelRatio conversion is needed
      // — Chromium handles HiDPI scaling internally.
      void ipcCallResult("browser", "setBounds", {
        tabId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }

    const dtEl = devtoolsPlaceholderRef.current;
    if (dtEl !== null) {
      const rect = dtEl.getBoundingClientRect();
      void ipcCallResult("browser", "setDevToolsBounds", {
        tabId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }, [tabId]);

  useEffect(() => {
    const pageEl = placeholderRef.current;
    if (pageEl === null) return;

    const observer = new ResizeObserver(() => {
      // Coalesce: cancel any pending frame and schedule a new one.
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = requestAnimationFrame(sendBounds);
    });

    observer.observe(pageEl);
    // The devtools placeholder is conditionally rendered — observe it too
    // when present so a splitter drag emits a coalesced bounds update.
    const dtEl = devtoolsPlaceholderRef.current;
    if (dtEl !== null) {
      observer.observe(dtEl);
    }

    // Send initial bounds immediately (element may already have size).
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(sendBounds);

    return () => {
      observer.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
    // devtoolsOpen is a dependency because the devtools placeholder mounts /
    // unmounts on toggle — the observer must rewire so a freshly-mounted
    // placeholder is observed (and the unmounted one stops being observed).
  }, [sendBounds, devtoolsOpen]);

  // -------------------------------------------------------------------------
  // Navigation handler (from UrlBar)
  // -------------------------------------------------------------------------
  function handleNavigate(url: string) {
    void ipcCallResult("browser", "navigate", { tabId, url });
  }

  // -------------------------------------------------------------------------
  // Splitter — pointer-driven resize of the DevTools region
  // -------------------------------------------------------------------------
  //
  // Dragging the 3-pixel handle moves the boundary between the page and
  // DevTools regions.  Pointermove handlers are attached to `window` so the
  // drag survives the cursor briefly leaving the 3-pixel target — standard
  // splitter behaviour.  Bounds are clamped so the page never collapses below
  // `MIN_PAGE_HEIGHT` and DevTools never falls below `MIN_DEVTOOLS_HEIGHT`.
  function onSplitterPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = devtoolsHeight;

    function onMove(ev: PointerEvent): void {
      const delta = startY - ev.clientY;
      const maxHeight = Math.max(
        MIN_DEVTOOLS_HEIGHT,
        window.innerHeight - MIN_PAGE_HEIGHT,
      );
      const next = Math.max(MIN_DEVTOOLS_HEIGHT, Math.min(maxHeight, startHeight + delta));
      setDevtoolsHeight(next);
    }
    function onUp(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (active only when this tab is active)
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isActive) return;

    function onKeyDown(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      // ⌘L — focus URL bar
      if (e.key === "l" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setUrlFocusToken((t) => t + 1);
        return;
      }

      // ⌘⇧R — hard reload
      if (e.key === "r" && e.shiftKey && !e.altKey) {
        e.preventDefault();
        void ipcCallResult("browser", "reload", { tabId, ignoreCache: true });
        return;
      }

      // ⌘R — reload
      if (e.key === "r" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void ipcCallResult("browser", "reload", { tabId });
        return;
      }

      // ⌘[ — go back
      if (e.key === "[" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void ipcCallResult("browser", "goBack", { tabId });
        return;
      }

      // ⌘] — go forward
      if (e.key === "]" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void ipcCallResult("browser", "goForward", { tabId });
        return;
      }

      // ⌘⌥I — toggle DevTools
      if (e.key === "i" && e.altKey && !e.shiftKey) {
        e.preventDefault();
        void ipcCallResult("browser", "openDevTools", { tabId });
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [tabId, isActive]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="flex flex-col h-full">
      {/* Toolbar row — matches EditorView's toolbar tone */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <NavControls
          tabId={tabId}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
        />
        <UrlBar
          currentUrl={currentUrl}
          isLoading={isLoading}
          onNavigate={handleNavigate}
          autoFocus={showEmptyState}
          focusToken={urlFocusToken}
          className="flex-1"
        />
        {/* DevTools toggle — sends `browser.openDevTools`.  Main toggles the
            inline-docked DevTools sibling view and broadcasts
            `devtoolsToggled`; the new state lands in `runtime.devtoolsOpen`
            which drives both the button's active style and the split layout
            below.  Same IPC as the ⌘⌥I shortcut. */}
        <button
          type="button"
          aria-label="Toggle DevTools"
          aria-pressed={devtoolsOpen}
          title="Toggle DevTools (⌘⌥I)"
          onClick={() => {
            void ipcCallResult("browser", "openDevTools", { tabId });
          }}
          className={cn(
            "flex items-center justify-center size-7 rounded-(--radius-control)",
            "transition-colors outline-none",
            "hover:bg-[var(--state-hover-bg)] hover:text-foreground",
            "active:bg-[var(--state-active-bg)]",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "[&_svg]:size-4 [&_svg]:pointer-events-none",
            devtoolsOpen
              ? "bg-[var(--state-active-bg)] text-foreground"
              : "text-muted-foreground",
          )}
        >
          <Wrench aria-hidden="true" />
        </button>
      </div>

      {/* Content area — flex column so the optional DevTools region docks
          below the page.  `min-h-0` is required for the inner flex children
          to shrink correctly inside a parent flex column. */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Page region — fills remaining height when DevTools is closed,
            shrinks to `flex-1` against the fixed DevTools height when open. */}
        <div className="relative flex-1 min-h-0">
          {showEmptyState && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <BrowserEmptyState />
            </div>
          )}
          {/* Placeholder: ResizeObserver target. The WebContentsView is overlaid
              by the main process using the CSS-pixel bounds of this element. */}
          <div
            ref={placeholderRef}
            className="absolute inset-0"
            aria-hidden="true"
            data-browser-placeholder={tabId}
          />
          {/* Suspend-time snapshot overlay.  Painted as an absolute-fill <img>
              so DOM modals/menus rendered above still see a still image of the
              page rather than a blank area.  Only mounted when a snapshot is
              available — the native WebContentsView paints above this <img>
              whenever it's visible, so there's no double-rendering during the
              normal "view shown" state. */}
          {snapshot && (
            <img
              src={snapshot}
              alt=""
              aria-hidden="true"
              draggable={false}
              className="absolute inset-0 w-full h-full object-cover object-left-top pointer-events-none select-none"
            />
          )}
        </div>

        {devtoolsOpen && (
          <>
            {/* Splitter — drag to resize the DevTools panel.  3px tall with
                a hover halo for affordance.  `role="separator"` and
                `aria-orientation="horizontal"` mark it as a sizing widget
                for assistive tech. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize DevTools"
              onPointerDown={onSplitterPointerDown}
              className={cn(
                "h-[3px] cursor-row-resize",
                "bg-[var(--surface-island-border)]",
                "hover:bg-[var(--accent)]/60 transition-colors",
              )}
            />
            {/* DevTools region — fixed CSS-pixel height controlled by the
                splitter.  `relative` lets the placeholder absolutely fill it. */}
            <div
              className="relative"
              style={{ height: `${devtoolsHeight}px`, minHeight: MIN_DEVTOOLS_HEIGHT }}
            >
              <div
                ref={devtoolsPlaceholderRef}
                className="absolute inset-0"
                aria-hidden="true"
                data-browser-devtools-placeholder={tabId}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
