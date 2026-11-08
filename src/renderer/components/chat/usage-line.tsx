// The line under a chat tab's composer: how full the context is and how
// much of the plan's usage limits is spent, in the colours of the context
// ring, turning to the warning colour from 80%. The narrower the tab, the
// less it says: first the token counts go, then the week's reset time, then
// the session's, and at the narrowest the words shorten; the percentages
// stay. Hovering a part tells it whole.

import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { resetParts, type UsageLine, type UsageMeter } from "../../services/chat/usage-line";
import { ContextRing } from "../ui/context-ring";
import { tooltipProps } from "../ui/tooltip";
import { formatTokens } from "./side-panel";

const WARN_AT = 80;

/** Where a detail shows, by the line's width: the most wanted holds out longest. */
const DETAIL = {
  sessionReset: "hidden @sm:inline",
  weekReset: "hidden @lg:inline",
  tokens: "hidden @xl:inline",
} as const;

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

export function UsageLineView({ line }: { line: UsageLine | null }) {
  const { t, i18n } = useTranslation();
  if (!line) return null;
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
  /** The word for a meter in the narrowest line. */
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
  const tip = (meter: UsageMeter): string => {
    const when = reset(meter);
    const head = t("chat.usage.meter_tip", {
      label: label(meter, true),
      percent: Math.round(meter.percent),
    });
    return when ? `${head} · ${when}` : head;
  };

  const { context } = line;
  return (
    <div className="@container -mt-1 px-1" data-testid="chat-usage-line">
      <div className="flex items-center gap-3 overflow-hidden whitespace-nowrap text-app-micro text-muted-foreground tabular-nums">
        {context && (
          <span
            className="flex shrink-0 items-center gap-1"
            data-usage="context"
            {...tooltipProps(
              t("chat.usage.context_tip", {
                used: formatTokens(context.used),
                max: formatTokens(context.max),
                percent: context.percent,
              }),
            )}
          >
            <ContextRing percent={context.percent} />
            <span className="hidden @xs:inline">{t("chat.usage.context")}</span>
            <Percent percent={context.percent} />
            <span className={cn(DETAIL.tokens, "text-muted-foreground/70")}>
              {formatTokens(context.used)} / {formatTokens(context.max)}
            </span>
          </span>
        )}
        {line.meters.map((meter) => {
          const when = reset(meter);
          const told =
            meter.kind === "weekly" && line.more.length > 0
              ? [tip(meter), ...line.more.map(tip)].join("\n")
              : tip(meter);
          return (
            <span
              key={`${meter.kind}-${meter.windowMins ?? ""}`}
              className="flex shrink-0 items-center gap-1"
              data-usage={meter.kind}
              {...tooltipProps(told)}
            >
              <Bar percent={meter.percent} />
              <span className="hidden @xs:inline">{label(meter)}</span>
              <span className="@xs:hidden">{short(meter)}</span>
              <Percent percent={meter.percent} />
              {when && (
                <span
                  className={cn(
                    meter.kind === "weekly" ? DETAIL.weekReset : DETAIL.sessionReset,
                    "text-muted-foreground/70",
                  )}
                >
                  {when}
                </span>
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
