// The line under a chat tab's composer: how full the context is and how
// much of the plan's usage limits is spent, in the colours of the context
// ring, turning to the warning colour from 80%. A tab too narrow for all of
// it says less, a step at a time and no more than it has to (usageViews):
// what is near its limit holds out longest, and what is left out is counted
// ("+2"). Hovering a part tells it whole. The agent list's detail shows the
// plan's part of it as a chip (UsageChip).

import { RotateCcw } from "lucide-react";
import { type ReactNode, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { useFitStep } from "../../hooks/use-fit-step";
import { useNow } from "../../services/agent-sessions/use-family";
import type { CodexModel } from "../../services/chat/codex-model";
import type { ChatModel } from "../../services/chat/model";
import { usePlanClaudeUsage, usePlanCodexLimits } from "../../services/chat/plan-usage";
import {
  claudeUsageLine,
  codexUsageLine,
  formatTokens,
  resetParts,
  type UsageLine,
  type UsageMeter,
  usageViews,
  WARN_AT,
} from "../../services/chat/usage-line";
import { ContextRing } from "../ui/context-ring";
import { tooltipProps } from "../ui/tooltip";

function Percent({ percent }: { percent: number }) {
  return (
    <span className={cn(percent >= WARN_AT && "text-(--state-warning-fg)")}>
      {Math.round(percent)}%
    </span>
  );
}

function Bar({ percent }: { percent: number }) {
  return (
    <span className="relative h-1 w-6 shrink-0 overflow-hidden rounded-full bg-current/25">
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          percent >= WARN_AT ? "bg-(--state-warning-fg)" : "bg-(--state-loading-indicator)",
        )}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </span>
  );
}

/** The words for a line's meters: their names, short and long, when they start over, and what hovering tells. */
function useUsageWords(line: UsageLine) {
  const { t, i18n } = useTranslation();
  const now = Date.now();

  const label = (meter: UsageMeter, long = false): string => {
    switch (meter.kind) {
      case "session":
        return t("chat.usage.kind.session");
      case "weekly":
        return long && line.more.length > 0
          ? t("chat.usage.kind.weekly_all")
          : t("chat.usage.kind.weekly");
      case "weekly_scoped":
        return t("chat.usage.kind.weekly_scoped", { scope: meter.scope ?? "" });
      case "window": {
        const mins = meter.windowMins ?? 0;
        return mins > 0 && mins % (24 * 60) === 0
          ? t("chat.usage.kind.days", { count: mins / (24 * 60) })
          : t("chat.usage.kind.hours", { count: Math.round(mins / 60) });
      }
    }
  };
  /** The word for a meter in a narrow line. */
  const short = (meter: UsageMeter): string =>
    meter.kind === "session"
      ? t("chat.usage.short.session")
      : meter.kind === "weekly"
        ? t("chat.usage.short.weekly")
        : label(meter);
  const reset = (meter: UsageMeter): string | null => {
    if (meter.resetsAt === undefined) return null;
    const parts = resetParts(meter.resetsAt, now, i18n.language);
    return parts.soon
      ? t("chat.usage.resets_time", { time: parts.time })
      : t("chat.usage.resets_date", {
          month: parts.month,
          day: parts.day,
          weekday: parts.weekday,
          time: parts.time,
        });
  };
  /** When a meter starts over, in a narrow line: "15:29", or "목 09:59" past a day. */
  const resetShort = (meter: UsageMeter): string | null => {
    if (meter.resetsAt === undefined) return null;
    const parts = resetParts(meter.resetsAt, now, i18n.language);
    return parts.soon
      ? parts.time
      : t("chat.usage.resets_short_date", { weekday: parts.weekday, time: parts.time });
  };
  const tip = (meter: UsageMeter): string => {
    const when = reset(meter);
    const head = t("chat.usage.meter_tip", {
      label: label(meter, true),
      percent: Math.round(meter.percent),
    });
    return when ? `${head} · ${when}` : head;
  };
  /** What hovering a meter tells: the week's for every model with each model's own. */
  const told = (meter: UsageMeter): string =>
    meter.kind === "weekly" && line.more.length > 0
      ? [tip(meter), ...line.more.map(tip)].join("\n")
      : tip(meter);
  return { label, short, reset, resetShort, told };
}

export function UsageLineView({
  line,
  trailing,
}: {
  line: UsageLine | null;
  /** What ends the line on its right: the tab's profile, its dot alone when `compact`. */
  trailing?: ((compact: boolean) => ReactNode) | undefined;
}) {
  if (!line) {
    if (!trailing) return null;
    return (
      <div className="-mt-1 px-1" data-testid="chat-usage-line">
        <div className="flex items-center justify-end text-app-micro text-muted-foreground">
          {trailing(false)}
        </div>
      </div>
    );
  }
  return <Line line={line} trailing={trailing} />;
}

interface TabUsageLineProps {
  workspaceId: string;
  profileId: string | undefined;
  /** Whether the tab is shown: the minute's clock runs only then. */
  visible: boolean;
  /** What ends the line on its right, as UsageLineView's. */
  trailing?: ((compact: boolean) => ReactNode) | undefined;
}

/**
 * The line under a Claude tab's composer. It reads the profile's plan usage
 * (the tab's own answer until the profile has one) and keeps the minute's
 * clock itself, so the asks every minute draw this line again, and only
 * when the numbers change: not the tab.
 */
export function ClaudeUsageLine({
  workspaceId,
  profileId,
  visible,
  trailing,
  contextUsage,
  usage,
}: TabUsageLineProps & Pick<ChatModel, "contextUsage" | "usage">) {
  const plan = usePlanClaudeUsage(workspaceId, profileId);
  const told = plan ?? usage;
  // A minute's clock, so a window that resets leaves the line while it shows.
  const now = useNow(visible, 60_000);
  const line = useMemo(
    () => claudeUsageLine({ contextUsage, usage: told }, now),
    [contextUsage, told, now],
  );
  return <UsageLineView line={line} trailing={trailing} />;
}

/** The line under a Codex tab's composer, as ClaudeUsageLine. */
export function CodexUsageLine({
  workspaceId,
  profileId,
  visible,
  trailing,
  tokens,
  rateLimits,
}: TabUsageLineProps & Pick<CodexModel, "tokens" | "rateLimits">) {
  const plan = usePlanCodexLimits(workspaceId, profileId);
  const limits = plan ?? rateLimits;
  const now = useNow(visible, 60_000);
  const line = useMemo(
    () => codexUsageLine({ tokens, rateLimits: limits }, now),
    [tokens, limits, now],
  );
  return <UsageLineView line={line} trailing={trailing} />;
}

function Line({ line, trailing }: { line: UsageLine; trailing?: (compact: boolean) => ReactNode }) {
  const { t, i18n } = useTranslation();
  const { label, short, reset, resetShort, told } = useUsageWords(line);
  const profile = trailing !== undefined;
  const views = useMemo(() => usageViews(line, { profile }), [line, profile]);
  const row = useRef<HTMLDivElement>(null);
  const step = useFitStep(
    row,
    `${JSON.stringify(line)}|${i18n.language}|${profile}`,
    views.length - 1,
  );
  const view = views[step] ?? views[0];
  const { context } = line;
  const contextTip = context
    ? t("chat.usage.context_tip", {
        used: formatTokens(context.used),
        max: formatTokens(context.max),
        percent: context.percent,
      })
    : "";
  const hidden = [...(view.hidden.context ? [contextTip] : []), ...view.hidden.meters.map(told)];
  return (
    <div className="-mt-1 px-1" data-testid="chat-usage-line">
      <div
        ref={row}
        className="flex items-center gap-3 overflow-hidden whitespace-nowrap text-app-micro text-muted-foreground tabular-nums"
        data-step={step}
      >
        {context && view.context && (
          <span
            className="flex shrink-0 items-center gap-1"
            data-usage="context"
            {...tooltipProps(contextTip)}
          >
            <ContextRing percent={context.percent} />
            {view.context.word && <span>{t("chat.usage.context")}</span>}
            <Percent percent={context.percent} />
            {view.context.tokens && (
              <span className="text-muted-foreground/70">
                {formatTokens(context.used)} / {formatTokens(context.max)}
              </span>
            )}
          </span>
        )}
        {view.meters.map(({ meter, bar, word, reset: when }) => {
          const said = when === "long" ? reset(meter) : when === "short" ? resetShort(meter) : null;
          return (
            <span
              key={`${meter.kind}-${meter.windowMins ?? ""}`}
              className="flex shrink-0 items-center gap-1"
              data-usage={meter.kind}
              {...tooltipProps(told(meter))}
            >
              {bar && <Bar percent={meter.percent} />}
              <span>{word === "long" ? label(meter) : short(meter)}</span>
              <Percent percent={meter.percent} />
              {said && (
                <span className="flex items-center gap-0.5 text-muted-foreground/70">
                  {when === "short" && <RotateCcw className="size-2.5" aria-hidden="true" />}
                  {said}
                </span>
              )}
            </span>
          );
        })}
        {hidden.length > 0 && (
          <span
            className="shrink-0 rounded-sm bg-current/15 px-1"
            data-usage="hidden"
            {...tooltipProps(hidden.join("\n"))}
          >
            +{hidden.length}
          </span>
        )}
        {trailing && (
          <span className="ml-auto flex shrink-0 items-center">{trailing(!view.profileName)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The plan's usage as a chip, in the agent list's detail: each meter's bar,
 * short name and percent, after the dot of the account it is (`dot`);
 * hovering tells the account (`head`), each meter whole and when it starts
 * over.
 */
export function UsageChip({
  line,
  head,
  dot,
}: {
  line: UsageLine;
  head?: string;
  dot?: ReactNode;
}) {
  const { short, told } = useUsageWords(line);
  if (line.meters.length === 0) return null;
  const tip = [...(head ? [head] : []), ...line.meters.map(told)].join("\n");
  return (
    <span
      className="flex shrink-0 items-center gap-2 tabular-nums"
      data-testid="usage-chip"
      {...tooltipProps(tip)}
    >
      {dot}
      {line.meters.map((meter) => (
        <span
          key={`${meter.kind}-${meter.windowMins ?? ""}`}
          className="flex shrink-0 items-center gap-1"
          data-usage={meter.kind}
        >
          <Bar percent={meter.percent} />
          {short(meter)}
          <Percent percent={meter.percent} />
        </span>
      ))}
    </span>
  );
}
