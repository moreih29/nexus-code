import { Check, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { RunTally } from "../../services/chat/tool-runs";
import { ToggleChevron } from "../ui/toggle-chevron";

const RUN_KINDS = ["commands", "reads", "edits", "searches", "others"] as const;

export function ToolRunLine({
  tally,
  running,
  open,
  onToggle,
  beside,
  children,
}: {
  tally: RunTally;
  running: boolean;
  open: boolean;
  onToggle: () => void;
  beside?: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const label = RUN_KINDS.filter((kind) => tally[kind] > 0)
    .map((kind) => t(`chat.tool.run.${kind}`, { count: tally[kind] }))
    .join(" · ");
  return (
    <div className="my-1 text-app-ui-sm" data-testid="chat-tool-run">
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-(--radius-control) px-1.5 py-1 text-left hover:bg-[var(--state-hover-bg)]"
        >
          {running ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-[var(--state-loading-indicator)]" />
          ) : (
            <Check
              className={cn(
                "size-3.5 shrink-0",
                tally.failed > 0 ? "text-muted-foreground" : "text-[var(--state-success-fg)]",
              )}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-muted-foreground" title={label}>
            {label}
          </span>
          {tally.failed > 0 && (
            <span className="shrink-0 text-[var(--state-error-fg)]">
              {t("chat.tool.run.failed", { count: tally.failed })}
            </span>
          )}
          {tally.denied > 0 && (
            <span className="shrink-0 text-muted-foreground">
              {t("chat.tool.run.denied", { count: tally.denied })}
            </span>
          )}
          <ToggleChevron open={open} />
        </button>
        {beside}
      </div>
      {children && <div className="ml-4 border-l border-border pl-2">{children}</div>}
    </div>
  );
}
