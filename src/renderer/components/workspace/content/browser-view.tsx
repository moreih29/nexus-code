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
 * back/forward availability, and loading state, then renders a toolbar
 * (NavControls + UrlBar) and the placeholder with an optional empty state.
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
 *   ⌘⌥I       → open DevTools
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserEmptyState } from "@/components/editor/browser/empty-state";
import { NavControls } from "@/components/editor/browser/nav-controls";
import { UrlBar } from "@/components/editor/browser/url-bar";
import { ipcCallResult } from "@/ipc/client";
import { resolveInitialBrowserUrl } from "@/state/operations/browser";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";

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

export function BrowserTabView({
  tabId,
  workspaceId,
  initialUrl,
  lastUrl,
  partition,
  isActive,
}: BrowserTabViewProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  // rAF id for coalesced setBounds calls — mirrors useModelSource rAF pattern.
  const rafIdRef = useRef<number | null>(null);
  // URL bar focus imperative trigger — incrementing causes UrlBar to focus+select.
  const [urlFocusToken, setUrlFocusToken] = useState(0);
  // Whether browser.create has been sent for this tabId.
  const createdRef = useRef(false);

  // Runtime state from main-process events.
  const runtime = useBrowserRuntimeStore((s) => s.runtimes.get(tabId));
  const currentUrl = runtime?.currentUrl ?? lastUrl;
  const canGoBack = runtime?.canGoBack ?? false;
  const canGoForward = runtime?.canGoForward ?? false;
  const isLoading = runtime?.isLoading ?? false;

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
  // ResizeObserver → rAF-coalesced setBounds
  // -------------------------------------------------------------------------
  const sendBounds = useCallback(() => {
    rafIdRef.current = null;
    const el = placeholderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio ?? 1;
    void ipcCallResult("browser", "setBounds", {
      tabId,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
      dpr,
    });
  }, [tabId]);

  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      // Coalesce: cancel any pending frame and schedule a new one.
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      rafIdRef.current = requestAnimationFrame(sendBounds);
    });

    observer.observe(el);

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
  }, [sendBounds]);

  // -------------------------------------------------------------------------
  // Navigation handler (from UrlBar)
  // -------------------------------------------------------------------------
  function handleNavigate(url: string) {
    void ipcCallResult("browser", "navigate", { tabId, url });
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

      // ⌘⌥I — open DevTools
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
      </div>

      {/* Content area — placeholder div for WebContentsView overlay */}
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
      </div>
    </div>
  );
}
