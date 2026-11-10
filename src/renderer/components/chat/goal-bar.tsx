// The goal a conversation works toward (/goal), where it is seen: a bar
// over the composer, a badge on the tab, a line in the agent view's row.
// The bar is one line, and a second for the last check's reason, however
// long the goal; opened, it shows the whole goal, its checks, and what can
// be done to it.

import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  Pause,
  Play,
  Target,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import type { CodexModel } from "../../services/chat/codex-model";
import {
  clockLabel,
  firstLineOf,
  type GoalStatus,
  type GoalView,
  goalSeconds,
  goalViewOf,
} from "../../services/chat/goal";
import { chatKey, useChatStore } from "../../services/chat/store";
import { formatTokens } from "../../services/chat/usage-line";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";

/** What the views read of a tab's goal, and of the turn that works on it. */
export interface TabGoal {
  goal: GoalView;
  running: boolean;
  startedAt?: number;
}

/**
 * The goal of a chat tab, while there is one to show: not once its bar was
 * closed after it ended. Re-renders only when the goal or the turn changes.
 */
export function useTabGoal(workspaceId: string, tabId: string): TabGoal | null {
  const key = chatKey(workspaceId, tabId);
  const parts = useChatStore(
    useShallow((s) => {
      const state = s.tabs[key];
      const model = state?.model as CodexModel | undefined;
      return {
        goal: model?.goal,
        threadGoal: model?.threadGoal,
        running: model?.running ?? false,
        startedAt: model?.turn?.startedAt,
        closed: state?.goalClosed,
      };
    }),
  );
  return useMemo(() => {
    const goal = goalViewOf(parts);
    if (!goal || (goal.ended && parts.closed === goal.key)) return null;
    return { goal, running: parts.running, startedAt: parts.startedAt };
  }, [parts]);
}

/** Closes the bar of a goal that ended. */
export function closeGoalBar(workspaceId: string, tabId: string, goal: GoalView): void {
  useChatStore
    .getState()
    .update(chatKey(workspaceId, tabId), (prev) => ({ ...prev, goalClosed: goal.key }));
}

/** The time now, every `ms` while `on`. */
function useNow(on: boolean, ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [on, ms]);
  return now;
}

/** Whether the goal's time counts on: a Claude goal always, a Codex goal while it works. */
function ticks(tab: TabGoal): boolean {
  if (tab.goal.ended) return false;
  return tab.goal.agent === "claude" || (tab.running && tab.goal.status === "active");
}

/** The status a goal shows: an active one that no turn works on waits. */
function shownStatus(tab: TabGoal): GoalStatus | "waiting" {
  return tab.goal.status === "active" && !tab.running ? "waiting" : tab.goal.status;
}

const STATUS_COLOR: Record<GoalStatus | "waiting", string> = {
  active: "var(--state-info-fg)",
  waiting: "var(--muted-foreground)",
  paused: "var(--state-warning-fg)",
  blocked: "var(--state-warning-fg)",
  usageLimited: "var(--state-warning-fg)",
  budgetLimited: "var(--state-warning-fg)",
  met: "var(--state-success-fg)",
  failed: "var(--state-error-fg)",
};

function StatusIcon({ status, className }: { status: GoalStatus | "waiting"; className?: string }) {
  const Icon =
    status === "met"
      ? CircleCheck
      : status === "failed"
        ? CircleX
        : status === "active" || status === "waiting"
          ? Target
          : Pause;
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", className)}
      style={{ color: STATUS_COLOR[status] }}
    />
  );
}

export interface GoalBarProps {
  tab: TabGoal;
  onClear: () => Promise<void>;
  /** Codex: pause the goal, or go on with it. */
  onStatus?: (status: "active" | "paused") => Promise<void>;
  onClose: () => void;
}

export function GoalBar({ tab, onClear, onStatus, onClose }: GoalBarProps) {
  const { t } = useTranslation();
  const { goal } = tab;
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const now = useNow(ticks(tab), 1000);
  const status = shownStatus(tab);
  const seconds = goalSeconds(goal, now, tab);
  const { line, more } = firstLineOf(goal.objective);
  const lastCheck = goal.checks[goal.checks.length - 1];
  const paused = !goal.ended && goal.status !== "active";
  // Opened, the checks show their latest: the last one is what matters.
  const checksRef = useRef<HTMLUListElement>(null);
  const checkCount = goal.checks.length + (goal.ended ? 1 : 0);
  useEffect(() => {
    if (open && checkCount > 0)
      checksRef.current?.scrollTo({ top: checksRef.current.scrollHeight });
  }, [open, checkCount]);

  const act = (run: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    run()
      .catch((err: Error) =>
        showToast({
          kind: "error",
          message: t("chat.goal.failed_action", { message: err.message }),
        }),
      )
      .finally(() => setBusy(false));
  };

  const timeTitle = goal.ended
    ? t("chat.goal.took")
    : goal.agent === "codex"
      ? t("chat.goal.worked")
      : t("chat.goal.since");

  const meta = (
    <span className="flex shrink-0 items-center gap-2.5 text-app-micro text-muted-foreground">
      {status !== "active" && (
        <span className="whitespace-nowrap" style={{ color: STATUS_COLOR[status] }}>
          {t(`chat.goal.status.${status}`)}
        </span>
      )}
      {seconds !== null && (
        <span
          className="flex items-center gap-1 font-mono text-foreground tabular-nums"
          title={timeTitle}
        >
          <Clock aria-hidden className="size-3" />
          {clockLabel(seconds)}
        </span>
      )}
      {goal.agent === "claude" && (goal.iterations ?? goal.checks.length) > 0 && (
        <span className="whitespace-nowrap @max-[420px]:hidden">
          {t("chat.goal.checks", { count: goal.iterations ?? goal.checks.length })}
        </span>
      )}
      {goal.tokenBudget ? (
        <span className="flex items-center gap-1.5 whitespace-nowrap @max-[420px]:hidden">
          <span className="relative h-1 w-12 overflow-hidden rounded-full bg-border">
            <span
              className="absolute inset-y-0 left-0"
              style={{
                width: `${Math.min(100, ((goal.tokens ?? 0) / goal.tokenBudget) * 100)}%`,
                background:
                  STATUS_COLOR[goal.status === "budgetLimited" ? "budgetLimited" : "active"],
              }}
            />
          </span>
          {t("chat.goal.budget", {
            used: formatTokens(goal.tokens ?? 0),
            budget: formatTokens(goal.tokenBudget),
          })}
        </span>
      ) : (
        (goal.agent === "codex" || goal.ended) &&
        (goal.tokens ?? 0) > 0 && (
          <span className="whitespace-nowrap @max-[420px]:hidden">
            {t("chat.goal.tokens", { used: formatTokens(goal.tokens ?? 0) })}
          </span>
        )
      )}
    </span>
  );

  // The second line, folded: what the last check found, or why it ended.
  const second = goal.ended
    ? goal.reason
    : lastCheck
      ? `${t("chat.goal.check_n", { count: goal.checks.length })} · ${lastCheck.reason}`
      : undefined;

  return (
    <section
      className="@container rounded-(--radius-control) border border-border border-l-[3px] bg-muted/40 px-2 py-1 text-app-ui-sm"
      style={{ borderLeftColor: STATUS_COLOR[status] }}
      aria-label={t("chat.goal.label")}
      data-testid="chat-goal-bar"
      data-status={status}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          title={open ? undefined : goal.objective}
        >
          <StatusIcon status={status} />
          {open ? (
            <span className="min-w-0 truncate text-app-micro text-muted-foreground">
              {t("chat.goal.label")} · {t("chat.goal.chars", { count: goal.objective.length })}
            </span>
          ) : (
            <>
              <span className="min-w-0 truncate text-foreground">{line}</span>
              {more > 0 && (
                <span className="shrink-0 text-app-micro text-muted-foreground">
                  {t("chat.goal.more_lines", { count: more })}
                </span>
              )}
            </>
          )}
        </button>
        {meta}
        <span className="flex shrink-0 items-center">
          {open && (
            <IconButton
              label={copied ? t("chat.goal.copied") : t("chat.goal.copy")}
              size="xs"
              onClick={() => {
                copyText(goal.objective);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </IconButton>
          )}
          {open && onStatus && !goal.ended && (
            <IconButton
              label={paused ? t("chat.goal.resume") : t("chat.goal.pause")}
              size="xs"
              disabled={busy}
              onClick={() => act(() => onStatus(paused ? "active" : "paused"))}
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </IconButton>
          )}
          {open && !goal.ended && (
            <IconButton
              label={
                goal.agent === "claude" && tab.running
                  ? t("chat.goal.clear_running")
                  : t("chat.goal.clear")
              }
              size="xs"
              disabled={busy}
              onClick={() => act(onClear)}
              data-testid="chat-goal-clear"
            >
              <Trash2 className="size-3.5" />
            </IconButton>
          )}
          {goal.ended && (
            <IconButton label={t("chat.goal.dismiss")} size="xs" onClick={onClose}>
              <X className="size-3.5" />
            </IconButton>
          )}
          <IconButton
            label={open ? t("chat.goal.collapse") : t("chat.goal.expand")}
            size="xs"
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </IconButton>
        </span>
      </div>
      {!open && second && (
        <div className="flex min-w-0 items-center gap-1 pl-5.5 text-app-micro text-muted-foreground">
          {!goal.ended && (
            <X aria-hidden className="size-3 shrink-0 text-[var(--state-warning-fg)]" />
          )}
          <span className="min-w-0 truncate" title={second}>
            {second}
          </span>
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 pt-1 pb-1 pl-5.5">
          <div className="app-scrollbar max-h-48 overflow-y-auto pr-1 text-app-body break-words whitespace-pre-wrap text-foreground">
            {goal.objective}
          </div>
          {(goal.checks.length > 0 || (goal.ended && goal.reason)) && (
            <ul
              ref={checksRef}
              className="app-scrollbar flex max-h-32 flex-col gap-1 overflow-y-auto border-t border-border pt-1.5 text-app-micro"
            >
              {goal.checks.map((check, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: checks are only ever added at the end
                <li key={i} className="flex min-w-0 gap-2 text-muted-foreground">
                  <span className="w-10 shrink-0 font-mono tabular-nums">
                    {check.at !== undefined ? clockOf(check.at) : ""}
                  </span>
                  <span className="shrink-0 text-[var(--state-warning-fg)]">
                    {t("chat.goal.unmet")}
                  </span>
                  <span className="min-w-0 break-words">{check.reason}</span>
                </li>
              ))}
              {goal.ended && goal.reason && (
                <li className="flex min-w-0 gap-2 text-muted-foreground">
                  <span className="w-10 shrink-0 font-mono tabular-nums">
                    {goal.endedAt !== undefined ? clockOf(goal.endedAt) : ""}
                  </span>
                  <span className="shrink-0" style={{ color: STATUS_COLOR[goal.status] }}>
                    {t(`chat.goal.status.${goal.status}`)}
                  </span>
                  <span className="min-w-0 break-words">{goal.reason}</span>
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** 15:14: the time of day of a check. */
function clockOf(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 1시간 12분, or 12분: a goal's time where a clock is too long (a tab's badge). */
function shortTime(seconds: number, t: ReturnType<typeof useTranslation>["t"]): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? t("chat.goal.short_hm", { h, m }) : t("chat.goal.short_m", { m });
}

/** A tab's goal on its header: its mark and how long, while it is not done. */
export function GoalTabBadge({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const { t } = useTranslation();
  const tab = useTabGoal(workspaceId, tabId);
  const now = useNow(tab !== null && ticks(tab), 10_000);
  if (!tab || tab.goal.ended) return null;
  const seconds = goalSeconds(tab.goal, now, tab);
  const status = shownStatus(tab);
  const time = seconds !== null ? shortTime(seconds, t) : "";
  return (
    <span
      data-tab-icon
      className="inline-flex shrink-0 items-center gap-0.5 text-app-micro tabular-nums"
      style={{ color: STATUS_COLOR[status] }}
      title={t("chat.goal.badge", { time, objective: tab.goal.objective })}
      data-testid="tab-goal-badge"
    >
      <Target aria-hidden className="size-3" />
      {time}
    </span>
  );
}

/** A chat's goal as a line in the agent view's row, while it is not done. */
export function GoalRowLine({ workspaceId, tabId }: { workspaceId: string; tabId: string }) {
  const tab = useTabGoal(workspaceId, tabId);
  const now = useNow(tab !== null && ticks(tab), 1000);
  if (!tab || tab.goal.ended) return null;
  const seconds = goalSeconds(tab.goal, now, tab);
  const status = shownStatus(tab);
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 pl-5.5 text-app-micro text-muted-foreground"
      data-testid="agent-goal-line"
    >
      <StatusIcon status={status} className="size-3" />
      <span className="min-w-0 flex-1 truncate" title={tab.goal.objective}>
        {firstLineOf(tab.goal.objective).line}
      </span>
      {seconds !== null && (
        <span className="shrink-0 font-mono text-foreground tabular-nums">
          {clockLabel(seconds)}
        </span>
      )}
    </div>
  );
}
