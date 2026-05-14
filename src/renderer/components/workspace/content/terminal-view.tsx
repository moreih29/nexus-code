import type { ReactNode, Ref } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { createTerminalController } from "@/services/terminal";
import { subscribeTerminalReopenRequest } from "@/services/terminal/reopen-requests";
import type { TerminalController } from "@/services/terminal/types";
import { useTabsStore } from "@/state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";

interface TerminalViewProps {
  workspaceId: string;
  tabId: string;
  cwd: string;
  /**
   * Identifies which layout leaf currently owns the tab. Used as one signal
   * for "DOM was moved → refresh".
   */
  ownerLeafId: string | null;
  /**
   * The current parent into which ContentHost has reparented the stable
   * per-tab portal element. When this element identity changes (slot →
   * hidden, hidden → slot, or slot-A → slot-B during a hoist), the xterm
   * canvas has been reparented and any WebGL/Canvas renderer can lose its
   * rasterized buffer in transit. We refresh xterm to repaint from the
   * in-memory line buffer; without this the viewport stays black until the
   * next data byte arrives.
   *
   * `ownerLeafId` does NOT cover this: a hoist that promotes the surviving
   * sibling reuses the same leaf id, but the DOM still moves because
   * GroupView's React tree position changes.
   */
  parentEl: HTMLElement | null;
  /**
   * Whether the tab is currently the active tab in its group AND the
   * workspace itself is the active workspace. visibility:hidden suspends
   * rendering for canvas/webgl; on becoming visible we must refresh to
   * repaint from the line buffer. Mirrors VSCode's setVisible() pattern.
   */
  isVisible: boolean;
}

type ReopenState = "idle" | "reopening" | "failed";

interface DeadTerminalBannerProps {
  message: string;
  actionLabel: string;
  actionDisabled?: boolean;
  onReopen: () => void;
}

interface TerminalViewLayoutProps {
  terminalEnded: boolean;
  banner?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

/**
 * Returns the user-visible dead-terminal message without inferring remote
 * process state beyond the fact that this terminal view ended.
 */
export function terminalEndedMessage(reopenState: ReopenState): string {
  if (reopenState === "failed") return "Reopen failed.";
  return "Terminal ended.";
}

/**
 * Displays the per-tab terminal-ended state while leaving xterm scrollback
 * below the banner available for selection.
 */
export function DeadTerminalBanner({
  message,
  actionLabel,
  actionDisabled = false,
  onReopen,
}: DeadTerminalBannerProps) {
  return (
    <div
      role="status"
      className="flex items-center justify-between shrink-0 h-6 px-3 bg-frosted-veil border-b border-mist-border text-app-ui-xs app-status-banner-text"
    >
      <span>{message}</span>
      <button
        type="button"
        className="text-app-ui-xs app-status-banner-text hover:opacity-80 cursor-pointer bg-transparent border-0 p-0 disabled:cursor-default disabled:opacity-60"
        disabled={actionDisabled}
        onClick={onReopen}
      >
        {actionLabel}
      </button>
    </div>
  );
}

/**
 * Suppresses redundant per-tab banners while the workspace-level offline
 * affordance is responsible for recovery.
 */
export function shouldShowTerminalEndedBanner(
  terminalEnded: boolean,
  workspaceOnline: boolean,
): boolean {
  return terminalEnded && workspaceOnline;
}

/**
 * Renders the terminal shell and dead-state dimming without owning PTY
 * lifecycle, making the scrollback affordance testable separately.
 */
export function TerminalViewLayout({
  terminalEnded,
  banner,
  containerRef,
}: TerminalViewLayoutProps) {
  return (
    <div className="w-full h-full bg-background flex flex-col min-h-0">
      {banner}
      <div
        ref={containerRef}
        className={cn(
          "w-full min-h-0 flex-1 bg-background pointer-events-auto",
          terminalEnded && "opacity-60",
        )}
      />
    </div>
  );
}

export function TerminalView({
  workspaceId,
  tabId,
  cwd,
  ownerLeafId,
  parentEl,
  isVisible,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [reopenState, setReopenState] = useState<ReopenState>("idle");
  const terminalEnded = useTabsStore((s) => {
    const tab = s.byWorkspace[workspaceId]?.[tabId];
    return tab?.type === "terminal" ? Boolean(tab.props.dead) : false;
  });
  const workspaceOnline = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspaceId));
  const showEndedBanner = shouldShowTerminalEndedBanner(terminalEnded, workspaceOnline);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    const shouldAutoSpawn = !(tab?.type === "terminal" && tab.props.dead);
    const controller = createTerminalController({
      workspaceId,
      tabId,
      cwd,
      container,
      autoSpawn: shouldAutoSpawn,
      onExit: () => {
        useTabsStore.getState().setTerminalDead(workspaceId, tabId, true);
        setReopenState("idle");
      },
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.dispose();
    };
  }, [workspaceId, tabId, cwd]);

  const handleReopen = useCallback(async (): Promise<void> => {
    if (reopenState === "reopening") return;
    setReopenState("reopening");
    try {
      const controller = controllerRef.current;
      if (!controller) throw new Error("terminal unavailable");
      await controller.reopen();
      useTabsStore.getState().setTerminalDead(workspaceId, tabId, false);
      setReopenState("idle");
    } catch {
      setReopenState("failed");
    }
  }, [reopenState, workspaceId, tabId]);

  // Keep a stable ref to the latest handler so the subscription below does not
  // need to re-subscribe every time reopenState changes. Without this, a state
  // transition (idle → reopening) would momentarily leave no subscriber, and
  // any external "Reopen all" that arrives during that gap would be silently
  // dropped.
  const handleReopenRef = useRef(handleReopen);
  useEffect(() => {
    handleReopenRef.current = handleReopen;
  });

  useEffect(() => {
    return subscribeTerminalReopenRequest(workspaceId, tabId, () => {
      void handleReopenRef.current();
    });
  }, [workspaceId, tabId]);

  // Refresh xterm whenever the DOM was reparented or visibility flipped
  // back to true. `ownerLeafId` is read by the effect indirectly: when the
  // portal target swaps to a new leaf, the leaf id changes even when the
  // refs we use inside the body don't, and we need the refresh to re-run.
  // Listed as a dep on purpose — biome's exhaustive-deps rule sees it as
  // unused, but removing it would skip the refresh on reparent.
  // biome-ignore lint/correctness/useExhaustiveDependencies: ownerLeafId is the reparent signal
  useEffect(() => {
    if (!parentEl) return;
    if (!isVisible) return;
    controllerRef.current?.refresh();
  }, [ownerLeafId, parentEl, isVisible]);

  return (
    <TerminalViewLayout
      terminalEnded={terminalEnded}
      containerRef={containerRef}
      banner={
        showEndedBanner ? (
          <DeadTerminalBanner
            message={terminalEndedMessage(reopenState)}
            actionLabel={
              reopenState === "failed"
                ? "Retry"
                : reopenState === "reopening"
                  ? "Reopening…"
                  : "Reopen"
            }
            actionDisabled={reopenState === "reopening"}
            onReopen={() => {
              void handleReopen();
            }}
          />
        ) : undefined
      }
    />
  );
}
