import i18next from "i18next";
import { Wrench } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserEmptyState } from "@/components/editor/browser/empty-state";
import { BrowserLoadError } from "@/components/editor/browser/load-error";
import { NavControls } from "@/components/editor/browser/nav-controls";
import { PickButton } from "@/components/editor/browser/pick-button";
import { UrlBar } from "@/components/editor/browser/url-bar";
import { IconButton } from "@/components/ui/icon-button";
import { ipcCallResult } from "@/ipc/client";
import { mountBrowserView, resolveInitialBrowserUrl } from "@/state/operations/browser";
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
  const [createRequest, setCreateRequest] = useState(() => ({
    url: resolveInitialBrowserUrl({ initialUrl, lastUrl, partition }) ?? BLANK_TAB_URL,
  }));
  const [creation, setCreation] = useState<{
    request: typeof createRequest;
    viewId: string | null;
  }>();
  const isCreating = creation?.request !== createRequest;
  const viewId = isCreating ? null : (creation?.viewId ?? null);
  const createFailed = creation?.viewId === null;
  const [devtoolsHeight, setDevtoolsHeight] = useState(DEFAULT_DEVTOOLS_HEIGHT);
  const contentAreaRef = useRef<HTMLDivElement>(null);
  const endSplitterDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endSplitterDragRef.current?.(), []);

  const runtime = useBrowserRuntimeStore((s) => s.runtimes.get(tabId));
  const currentUrl = runtime?.currentUrl ?? lastUrl;
  const canGoBack = runtime?.canGoBack ?? false;
  const canGoForward = runtime?.canGoForward ?? false;
  const isLoading = isCreating || (viewId !== null && runtime?.isLoading === true);
  const loadFailure = createFailed
    ? {
        url: createRequest.url === BLANK_TAB_URL ? "" : createRequest.url,
        description: "ERR_BROWSER_CREATE_FAILED",
      }
    : (runtime?.loadFailure ?? null);
  const snapshot = runtime?.snapshot ?? null;
  const devtoolsOpen = runtime?.devtoolsOpen ?? false;
  const urlFocusToken = runtime?.urlFocusToken ?? 0;

  const showEmptyState =
    !loadFailure && (currentUrl === "" || currentUrl === BLANK_TAB_URL) && lastUrl === "";

  useEffect(
    () =>
      mountBrowserView({ tabId, workspaceId, partition, url: createRequest.url }, (viewId) =>
        setCreation({ request: createRequest, viewId }),
      ),
    [tabId, workspaceId, partition, createRequest],
  );

  const sendBounds = useCallback(() => {
    rafIdRef.current = null;
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
  }, [tabId, viewId]);

  const scheduleSendBounds = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(sendBounds);
  }, [sendBounds]);

  useEffect(() => {
    if (viewId === null) return;
    void ipcCallResult("browser", "setActive", { tabId, viewId, active: isActive });
    if (isActive) {
      scheduleSendBounds();
    }
  }, [tabId, viewId, isActive, scheduleSendBounds]);

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
    if (viewId === null) {
      setCreateRequest({ url });
      return;
    }
    void ipcCallResult("browser", "navigate", { tabId, url });
  }

  function handleReload() {
    if (isCreating) return;
    if (createFailed) setCreateRequest({ url: createRequest.url });
    else void ipcCallResult("browser", "reload", { tabId });
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
        <NavControls
          tabId={tabId}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onReload={handleReload}
        />
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
            <BrowserLoadError failure={loadFailure} isLoading={isLoading} onRetry={handleReload} />
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
