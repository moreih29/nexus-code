import i18next from "i18next";
import type { ReactNode, Ref } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { createTerminalController } from "@/services/terminal";
import { subscribeTerminalReopenRequest } from "@/services/terminal/reopen-requests";
import type { TerminalController } from "@/services/terminal/types";
import { useTabsStore } from "@/state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import { ipcListen } from "@/ipc/client";
import { Banner } from "../../ui/banner";

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

/**
 * Grace window for daemon reattach after disconnect (300 s, matches daemon constant).
 * Only used for countdown display — the exact sync with daemon is not required.
 */
const REATTACH_GRACE_SECONDS = 300;

export interface DeadTerminalBannerProps {
  message: string;
  actionLabel: string;
  actionDisabled?: boolean;
  onReopen: () => void;
}

interface TerminalViewLayoutProps {
  terminalEnded: boolean;
  /** When true, the terminal is dim because PTY sessions are on hold. */
  held?: boolean;
  banner?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

/**
 * Returns the user-visible dead-terminal message without inferring remote
 * process state beyond the fact that this terminal view ended.
 */
export function terminalEndedMessage(reopenState: ReopenState): string {
  if (reopenState === "failed") return i18next.t("terminal.reopen_failed");
  return i18next.t("terminal.ended");
}

/**
 * Displays the per-tab terminal-ended state while leaving xterm scrollback
 * below the banner available for selection.
 *
 * Delegates to Banner display="bar" for visual consistency with other bar
 * banners (ReadOnlyBanner, ConflictResolvedBanner). Kept as a named export
 * because unit tests import it directly and because actionDisabled cannot be
 * expressed through BannerAction (Banner has no per-action disabled prop).
 *
 * Note: when actionDisabled is true the action is omitted entirely so that
 * Banner's action list carries no disabled-state button — the "Reopening…"
 * label makes the in-progress state self-evident without an interactive control.
 */
export function DeadTerminalBanner({
  message,
  actionLabel,
  actionDisabled = false,
  onReopen,
}: DeadTerminalBannerProps) {
  return (
    <Banner
      display="bar"
      variant="info"
      message={message}
      actions={actionDisabled ? [] : [{ label: actionLabel, onAction: onReopen }]}
      role="status"
    />
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
  held = false,
  banner,
  containerRef,
}: TerminalViewLayoutProps) {
  return (
    <div className="w-full h-full flex flex-col min-h-0">
      {banner}
      <div
        ref={containerRef}
        className={cn(
          "w-full min-h-0 flex-1 pointer-events-auto",
          // `terminalEnded` and `held` both dim the scrollback: a dead terminal
          // is dimmed to signal it ended; a held terminal is dimmed to indicate
          // input is paused. Both reuse the same opacity-60 token from design.md.
          (terminalEnded || held) && "opacity-60",
        )}
      />
    </div>
  );
}

/**
 * Computes remaining grace minutes for the held-terminal countdown banner.
 * Approximation — exact sync with the daemon clock is not required.
 */
export function heldGraceMinutesRemaining(heldAt: number, nowMs: number): number {
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - heldAt) / 1000));
  const remaining = Math.max(0, REATTACH_GRACE_SECONDS - elapsedSeconds);
  return Math.ceil(remaining / 60);
}

export function TerminalView({
  workspaceId,
  tabId,
  cwd,
  ownerLeafId,
  parentEl,
  isVisible,
}: TerminalViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<TerminalController | null>(null);
  const [reopenState, setReopenState] = useState<ReopenState>("idle");

  // ---------------------------------------------------------------------------
  // PTY hold/restore/expire state — driven by pty.held / pty.restored / pty.expired
  // ---------------------------------------------------------------------------

  /** Epoch-ms when the `pty.held` event arrived for this tab. */
  const [heldAt, setHeldAt] = useState<number | null>(null);
  /** After `pty.restored`, flash a success banner for ~2 s then auto-clear. */
  const [showRestoredFlash, setShowRestoredFlash] = useState(false);
  /** Shown dim-inline on first keypress while held. */
  const [showInputHint, setShowInputHint] = useState(false);
  /** Minutes remaining in the grace window — updated per-minute, not per-second. */
  const [graceMinutes, setGraceMinutes] = useState<number>(
    Math.ceil(REATTACH_GRACE_SECONDS / 60),
  );
  const isHeld = heldAt !== null;

  // Subscribe to `pty.held` / `pty.restored` / `pty.expired` for this tab.
  useEffect(() => {
    const unlistenHeld = ipcListen("pty", "held", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      setHeldAt(Date.now());
      setShowInputHint(false);
      setShowRestoredFlash(false);
    });

    const unlistenRestored = ipcListen("pty", "restored", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      // \x1bc reset is injected inline in the data stream by agent-host
      // (restoreHeldSessions) before pty.replay is requested, so ordering is
      // structurally guaranteed: reset → replay data → wiggle repaint.
      // A renderer-side writeReset() call here races the data stream and would
      // wipe the repaint when replay arrives first — do NOT call writeReset here.
      setHeldAt(null);
      setShowInputHint(false);
      setShowRestoredFlash(true);
    });

    const unlistenExpired = ipcListen("pty", "expired", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      // Terminal is dead; clear hold state. The tab will receive pty.exit
      // shortly after, which drives the DeadTerminalBanner path.
      setHeldAt(null);
      setShowInputHint(false);
    });

    return () => {
      unlistenHeld();
      unlistenRestored();
      unlistenExpired();
    };
  }, [workspaceId, tabId]);

  // Auto-dismiss the "Restored" success flash after ~2 s.
  useEffect(() => {
    if (!showRestoredFlash) return;
    const timer = setTimeout(() => setShowRestoredFlash(false), 2000);
    return () => clearTimeout(timer);
  }, [showRestoredFlash]);

  // Per-minute countdown tick while held. No per-second re-render.
  useEffect(() => {
    if (heldAt === null) return;
    // Initial value
    setGraceMinutes(heldGraceMinutesRemaining(heldAt, Date.now()));

    const interval = setInterval(() => {
      setGraceMinutes(heldGraceMinutesRemaining(heldAt, Date.now()));
    }, 60_000);
    return () => clearInterval(interval);
  }, [heldAt]);

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

  // Show the one-line "input held" hint on the first keypress while the PTY
  // is on hold. Attach a DOM keydown listener on the terminal container so we
  // intercept before xterm (which will drop the input in main). The hint
  // auto-dismisses when the session is restored (setHeldAt(null) path above).
  useEffect(() => {
    if (!isHeld) return;
    const container = containerRef.current;
    if (!container) return;

    function onKeyDown(): void {
      setShowInputHint(true);
    }
    container.addEventListener("keydown", onKeyDown, { capture: true });
    return () => container.removeEventListener("keydown", onKeyDown, { capture: true });
    // containerRef is a ref — its .current changes don't trigger re-runs.
    // isHeld drives mount/unmount of this effect which is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeld]);

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

  // ---------------------------------------------------------------------------
  // Banner selection — at most one banner is shown at a time, with priority:
  //   1. DeadTerminalBanner (terminal ended + workspace online)
  //   2. Restored flash ("복원됨") — auto-dismissed after ~2 s
  //   3. Held warning banner (reconnecting, countdown)
  //   4. Held input hint (first keypress while held)
  // ---------------------------------------------------------------------------
  let activeBanner: ReactNode = undefined;
  if (showEndedBanner) {
    activeBanner = (
      <DeadTerminalBanner
        message={terminalEndedMessage(reopenState)}
        actionLabel={
          reopenState === "failed"
            ? t("action.retry")
            : reopenState === "reopening"
              ? t("terminal.reopening")
              : t("terminal.reopen")
        }
        actionDisabled={reopenState === "reopening"}
        onReopen={() => {
          void handleReopen();
        }}
      />
    );
  } else if (showRestoredFlash) {
    activeBanner = (
      <Banner
        display="bar"
        variant="success"
        message={t("terminal.restored_banner")}
        role="status"
        aria-live="polite"
      />
    );
  } else if (isHeld) {
    activeBanner = (
      <Banner
        display="bar"
        variant="warning"
        message={t("terminal.held_banner", { minutes: graceMinutes })}
        role="status"
        aria-live="polite"
      />
    );
  } else if (showInputHint) {
    activeBanner = (
      <Banner
        display="bar"
        variant="info"
        message={t("terminal.held_input_hint")}
        role="status"
      />
    );
  }

  return (
    <TerminalViewLayout
      terminalEnded={terminalEnded}
      held={isHeld}
      containerRef={containerRef}
      banner={activeBanner}
    />
  );
}
