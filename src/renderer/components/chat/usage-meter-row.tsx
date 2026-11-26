import { useTranslation } from "react-i18next";
import { meterLevel, shownReset, type UsageMeter } from "../../services/chat/usage-line";
import { cn } from "../../utils/cn";
import { Row } from "./panel-section";
import { usageMeterLabel } from "./usage-line";

export function usageMeterKey(meter: UsageMeter): string {
  return `${meter.kind}-${meter.scope ?? ""}-${meter.windowMins ?? ""}`;
}

export function UsageMeterRow({
  meter,
  scoped,
  stale,
}: {
  meter: UsageMeter;
  scoped: boolean;
  stale?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className={cn("flex flex-col gap-0.5 py-0.5", stale && "opacity-60")}>
      <Row className="text-app-micro">
        <span className="min-w-0 flex-1 truncate">{usageMeterLabel(t, meter, scoped)}</span>
        <span className="shrink-0 tabular-nums">{Math.round(meter.percent)}%</span>
      </Row>
      <Meter percent={Math.min(100, meter.percent)} />
      {meter.resetsAt !== undefined && (
        <div className="text-app-micro text-muted-foreground">
          {t("chat.panel.usage.resets", {
            time: shownReset(meter.resetsAt).toLocaleString(i18n.language, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            }),
          })}
        </div>
      )}
    </div>
  );
}

export function Meter({ percent }: { percent: number }) {
  const level = meterLevel(percent);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          level === "alert"
            ? "bg-[var(--state-error-fg)]"
            : level === "warn"
              ? "bg-[var(--state-warning-fg)]"
              : "bg-[var(--tab-claude-running-fg)]",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
