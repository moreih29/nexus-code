import i18next from "i18next";
import { Wrench } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserEmptyState } from "@/components/editor/browser/empty-state";
import { NavControls } from "@/components/editor/browser/nav-controls";
import { PickButton } from "@/components/editor/browser/pick-button";
import { UrlBar } from "@/components/editor/browser/url-bar";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { ipcCallResult } from "@/ipc/client";
import {
  beginBrowserView,
  endBrowserView,
  resolveInitialBrowserUrl,
} from "@/state/operations/browser";
import { useBrowserRuntimeStore } from "@/state/stores/browser-runtime";
import { cn } from "@/utils/cn";

interface BrowserTabViewProps {
  tabId: string;
  workspaceId: string;
  initialUrl: string;
  lastUrl: string;
  partition: string;
  isActive: boolean;
  parentEl: HTMLElement | null;
}

const BLANK_TAB_URL = "about:blank";

const DEFAULT_DEVTOOLS_HEIGHT = 280;
const MIN_DEVTOOLS_HEIGHT = 120;
const MIN_PAGE_HEIGHT = 100;
const SPLITTER_HEIGHT = 3;

export function BrowserTabView({
  tabId,
  workspaceId,
  initialUrl,
  lastUrl,
  partition,
  isActive,
  parentEl,
}: BrowserTabViewProps) {
  const placeholderRef = useRef<HTMLDivElement>(null);
  const devtoolsPlaceholderRef = useRef<HTMLDivElement>(null);
  const rafIdRef = useRef<number | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const [devtoolsHeight, setDevtoolsHeight] = useState(DEFAULT_DEVTOOLS_HEIGHT);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const endSplitterDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endSplitterDragRef.current?.(), []);

  const runtime = useBrowserRuntimeStore((s) => s.runtimes.get(tabId));
  const currentUrl = runtime?.currentUrl ?? lastUrl;
  const canGoBack = runtime?.canGoBack ?? false;
  const canGoForward = runtime?.canGoForward ?? false;
  const isLoading = runtime?.isLoading ?? false;
  const loadFailure = runtime?.loadFailure ?? null;
  const snapshot = runtime?.snapshot ?? null;
  const devtoolsOpen = runtime?.devtoolsOpen ?? false;
  const urlFocusToken = runtime?.urlFocusToken ?? 0;

  const showEmptyState =
    !loadFailure && (currentUrl === "" || currentUrl === BLANK_TAB_URL) && lastUrl === "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: tabId/workspaceId/partition are stable for lifetime
  useEffect(() => {
    const viewId = beginBrowserView(workspaceId, tabId);
    viewIdRef.current = viewId;

    const url = resolveInitialBrowserUrl({ initialUrl, lastUrl, partition }) ?? BLANK_TAB_URL;
    void ipcCallResult("browser", "create", {
      tabId,
      viewId,
      workspaceId,
      url,
      partition,
    });

    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      endBrowserView(tabId, viewId);
      viewIdRef.current = null;
      void ipcCallResult("browser", "destroy", { tabId, viewId });
    };
  }, []);

  const sendBounds = useCallback(() => {
    rafIdRef.current = null;
    const viewId = viewIdRef.current;
    if (viewId === null) return;

    const pageEl = placeholderRef.current;
    if (pageEl !== null) {
      const rect = pageEl.getBoundingClientRect();
      void ipcCallResult("browser", "setBounds", {
        tabId,
        viewId,
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
        viewId,
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    }
  }, [tabId]);

  const scheduleSendBounds = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(sendBounds);
  }, [sendBounds]);

  useEffect(() => {
    const viewId = viewIdRef.current;
    if (viewId === null) return;
    void ipcCallResult("browser", "setActive", { tabId, viewId, active: isActive });
    if (isActive) {
      scheduleSendBounds();
    }
  }, [tabId, isActive, scheduleSendBounds]);

  useEffect(() => {
    if (parentEl === null) return;
    scheduleSendBounds();
  }, [parentEl, scheduleSendBounds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: devtoolsOpen is not read in the body but intentionally re-runs the effect to rewire the observer to the toggled devtools placeholder.
  useEffect(() => {
    const pageEl = placeholderRef.current;
    if (pageEl === null) return;

    const observer = new ResizeObserver(() => {
      scheduleSendBounds();
    });

    observer.observe(pageEl);
    const dtEl = devtoolsPlaceholderRef.current;
    if (dtEl !== null) {
      observer.observe(dtEl);
    }

    scheduleSendBounds();

    return () => {
      observer.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scheduleSendBounds, devtoolsOpen]);

  function handleNavigate(url: string) {
    void ipcCallResult("browser", "navigate", { tabId, url });
  }

  function onSplitterPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    endSplitterDragRef.current?.();
    const startY = e.clientY;
    const startHeight = devtoolsHeight;
    const columnHeight =
      contentAreaRef.current?.getBoundingClientRect().height ?? window.innerHeight;
    const maxHeight = Math.max(
      MIN_DEVTOOLS_HEIGHT,
      columnHeight - SPLITTER_HEIGHT - MIN_PAGE_HEIGHT,
    );

    function onMove(ev: PointerEvent): void {
      if (ev.buttons === 0) {
        endDrag();
        return;
      }
      const delta = startY - ev.clientY;
      const next = Math.max(MIN_DEVTOOLS_HEIGHT, Math.min(maxHeight, startHeight + delta));
      setDevtoolsHeight(next);
    }
    function endDrag(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
      if (endSplitterDragRef.current === endDrag) endSplitterDragRef.current = null;
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    endSplitterDragRef.current = endDrag;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 overflow-hidden px-2 py-1 border-b border-[var(--surface-island-border)]">
        <NavControls tabId={tabId} canGoBack={canGoBack} canGoForward={canGoForward} />
        <UrlBar
          currentUrl={loadFailure?.url ?? currentUrl}
          isLoading={isLoading}
          onNavigate={handleNavigate}
          autoFocus={showEmptyState}
          focusToken={urlFocusToken}
          className="min-w-0 flex-1"
        />
        <PickButton tabId={tabId} workspaceId={workspaceId} />
        <IconButton
          label={i18next.t("browser.toggle_devtools")}
          size="md"
          aria-pressed={devtoolsOpen}
          onClick={() => {
            void ipcCallResult("browser", "openDevTools", { tabId });
          }}
          className={cn(
            "active:bg-[var(--state-active-bg)] [&_svg]:size-4 [&_svg]:pointer-events-none",
            devtoolsOpen && "bg-[var(--state-active-bg)] text-foreground",
          )}
        >
          <Wrench aria-hidden="true" />
        </IconButton>
      </div>

      <div ref={contentAreaRef} className="flex flex-col flex-1 min-h-0">
        <div className="relative flex-1 min-h-0">
          {showEmptyState && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <BrowserEmptyState />
            </div>
          )}
          {loadFailure && (
            <div className="absolute inset-0 flex overflow-auto">
              <EmptyState
                title={i18next.t("browser.load_failed", { error: loadFailure.description })}
                description={loadFailure.url}
                actionLabel={i18next.t("action.retry")}
                onAction={() => void ipcCallResult("browser", "reload", { tabId })}
                disabled={isLoading}
                tone="status"
                className="[overflow-wrap:anywhere]"
              />
            </div>
          )}
          <div
            ref={placeholderRef}
            className="absolute inset-0 pointer-events-none"
            aria-hidden="true"
            data-browser-placeholder={loadFailure ? undefined : tabId}
          />
          {snapshot && !loadFailure && (
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
            {/* biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useSemanticElements: pointer-only splitter; no semantic HTML element exists for a draggable splitter handle. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={i18next.t("browser.resize_devtools")}
              aria-valuenow={devtoolsHeight}
              aria-valuemin={MIN_DEVTOOLS_HEIGHT}
              onPointerDown={onSplitterPointerDown}
              className={cn(
                "h-[3px] cursor-row-resize",
                "bg-[var(--surface-island-border)]",
                "hover:bg-[var(--accent)]/60 transition-colors",
              )}
            />
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
