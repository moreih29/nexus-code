import i18next from "i18next";
import type { ReactNode, Ref } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@xterm/xterm/css/xterm.css";
import { ipcListen } from "@/ipc/client";
import { registerTabFocusTarget, requestTabFocus } from "@/services/tab-focus";
import { createTerminalController } from "@/services/terminal/controller";
import { subscribeTerminalReopenRequest } from "@/services/terminal/reopen-requests";
import { registerTerminalController } from "@/services/terminal/terminal-registry";
import type { TerminalController } from "@/services/terminal/types";
import { useTabsStore } from "@/state/stores/tabs";
import { selectIsWorkspaceOnline, useWorkspacesStore } from "@/state/stores/workspaces";
import { cn } from "@/utils/cn";
import type { TerminalTabProps } from "../../../../shared/types/layout";
import { bannerEventId, useBannerDismissal } from "../../../hooks/use-banner-dismissal";
import { Banner, type BannerDismiss } from "../../ui/banner";

interface TerminalViewProps {
  workspaceId: string;
  tabId: string;
  cwd: string;
  ownerLeafId: string | null;
  parentEl: HTMLElement | null;
  isVisible: boolean;
}

type ReopenState = "idle" | "reopening" | "failed";

const reopenFailures = new WeakMap<TerminalTabProps, number>();

const REATTACH_GRACE_SECONDS = 300;

export interface DeadTerminalBannerProps {
  dismiss?: BannerDismiss | undefined;
  message: string;
  actionLabel: string;
  actionDisabled?: boolean;
  onReopen: () => void;
}

interface TerminalViewLayoutProps {
  terminalEnded: boolean;
  held?: boolean;
  banner?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

export function terminalEndedMessage(reopenState: ReopenState): string {
  if (reopenState === "failed") return i18next.t("terminal.reopen_failed");
  return i18next.t("terminal.ended");
}

export function DeadTerminalBanner({
  dismiss,
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
      dismiss={dismiss}
      actions={actionDisabled ? [] : [{ label: actionLabel, onAction: onReopen }]}
      role="status"
    />
  );
}

export function shouldShowTerminalEndedBanner(
  terminalEnded: boolean,
  workspaceOnline: boolean,
): boolean {
  return terminalEnded && workspaceOnline;
}

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
          (terminalEnded || held) && "opacity-60",
        )}
      />
    </div>
  );
}

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
  const reopenPending = useRef(false);
  const [reopen, setReopen] = useState({ pending: false });

  const [heldAt, setHeldAt] = useState<number | null>(null);
  const [showRestoredFlash, setShowRestoredFlash] = useState(false);
  const [showInputHint, setShowInputHint] = useState(false);
  const [graceMinutes, setGraceMinutes] = useState<number>(Math.ceil(REATTACH_GRACE_SECONDS / 60));
  const isHeld = heldAt !== null;

  useEffect(() => {
    const unlistenHeld = ipcListen("pty", "held", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      setHeldAt(Date.now());
      setShowInputHint(false);
      setShowRestoredFlash(false);
    });

    const unlistenRestored = ipcListen("pty", "restored", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      setHeldAt(null);
      setShowInputHint(false);
      setShowRestoredFlash(true);
    });

    const unlistenExpired = ipcListen("pty", "expired", (args) => {
      if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
      setHeldAt(null);
      setShowInputHint(false);
    });

    return () => {
      unlistenHeld();
      unlistenRestored();
      unlistenExpired();
    };
  }, [workspaceId, tabId]);

  useEffect(() => {
    if (!showInputHint) return;
    const timer = setTimeout(() => setShowInputHint(false), 3000);
    return () => clearTimeout(timer);
  }, [showInputHint]);

  useEffect(() => {
    if (!showRestoredFlash) return;
    const timer = setTimeout(() => setShowRestoredFlash(false), 2000);
    return () => clearTimeout(timer);
  }, [showRestoredFlash]);

  useEffect(() => {
    if (heldAt === null) return;
    setGraceMinutes(heldGraceMinutesRemaining(heldAt, Date.now()));

    const interval = setInterval(() => {
      setGraceMinutes(heldGraceMinutesRemaining(heldAt, Date.now()));
    }, 60_000);
    return () => clearInterval(interval);
  }, [heldAt]);

  const endedTerminal = useTabsStore((s) => {
    const tab = s.byWorkspace[workspaceId]?.[tabId];
    return tab?.type === "terminal" && tab.props.dead ? tab.props : undefined;
  });
  const terminalEnded = endedTerminal !== undefined;
  const failures = endedTerminal ? (reopenFailures.get(endedTerminal) ?? 0) : 0;
  const reopenState: ReopenState = reopen.pending ? "reopening" : failures > 0 ? "failed" : "idle";
  const workspaceOnline = useWorkspacesStore((s) => selectIsWorkspaceOnline(s, workspaceId));
  const endedNotice = useBannerDismissal(
    ["terminal-ended", workspaceId, tabId],
    endedTerminal ? [bannerEventId(endedTerminal), failures] : undefined,
  );
  const showEndedBanner =
    shouldShowTerminalEndedBanner(terminalEnded, workspaceOnline) &&
    (reopenState === "reopening" || !endedNotice.dismissed);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    const shouldAutoSpawn = !(tab?.type === "terminal" && tab.props.dead);
    const controller = createTerminalController({
      workspaceId,
      tabId,
      cwd,
      shell: tab?.type === "terminal" ? tab.props.shell : undefined,
      ...(tab?.type === "terminal" && tab.props.profile !== undefined
        ? { profile: tab.props.profile }
        : {}),
      container,
      autoSpawn: shouldAutoSpawn,
      onExit: () => {
        setHeldAt(null);
        setShowInputHint(false);
        setShowRestoredFlash(false);
        useTabsStore.getState().setTerminalDead(workspaceId, tabId, true);
      },
    });
    controllerRef.current = controller;
    const unregisterFocus = registerTabFocusTarget(tabId, (wanted) => controller.focus(wanted));
    const unregisterController = registerTerminalController(tabId, controller);
    return () => {
      unregisterFocus();
      unregisterController();
      controllerRef.current = null;
      controller.dispose();
    };
  }, [workspaceId, tabId, cwd]);

  useEffect(() => {
    if (!isHeld) return;
    const container = containerRef.current;
    if (!container) return;

    function onKeyDown(): void {
      setShowInputHint(true);
    }
    container.addEventListener("keydown", onKeyDown, { capture: true });
    return () => container.removeEventListener("keydown", onKeyDown, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHeld]);

  const handleReopen = useCallback(async (): Promise<void> => {
    const tab = useTabsStore.getState().byWorkspace[workspaceId]?.[tabId];
    if (reopenPending.current || tab?.type !== "terminal" || !tab.props.dead) return;
    const ended = tab.props;
    reopenPending.current = true;
    setReopen({ pending: true });
    try {
      const controller = controllerRef.current;
      if (!controller) throw new Error("terminal unavailable");
      await controller.reopen();
      useTabsStore.getState().setTerminalDead(workspaceId, tabId, false);
    } catch {
      reopenFailures.set(ended, (reopenFailures.get(ended) ?? 0) + 1);
    } finally {
      reopenPending.current = false;
      setReopen({ pending: false });
    }
  }, [workspaceId, tabId]);

  useEffect(() => {
    return subscribeTerminalReopenRequest(workspaceId, tabId, () => {
      void handleReopen();
    });
  }, [workspaceId, tabId, handleReopen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ownerLeafId is the reparent signal
  useEffect(() => {
    if (!parentEl) return;
    if (!isVisible) return;
    controllerRef.current?.refresh();
  }, [ownerLeafId, parentEl, isVisible]);

  let activeBanner: ReactNode;
  if (showEndedBanner) {
    activeBanner = (
      <DeadTerminalBanner
        message={terminalEndedMessage(reopenState)}
        dismiss={
          reopenState === "reopening"
            ? undefined
            : {
                label: endedNotice.dismiss.label,
                onDismiss: () => {
                  endedNotice.dismiss.onDismiss();
                  requestTabFocus(tabId);
                },
              }
        }
        actionLabel={
          reopenState === "failed"
            ? t("action.retry")
            : reopenState === "reopening"
              ? t("terminal.reopening")
              : t("terminal.reopen")
        }
        actionDisabled={reopenState === "reopening"}
        onReopen={() => {
          requestTabFocus(tabId);
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
  } else if (isHeld && showInputHint) {
    activeBanner = (
      <Banner display="bar" variant="info" message={t("terminal.held_input_hint")} role="status" />
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
