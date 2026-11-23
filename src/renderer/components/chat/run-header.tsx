import i18next from "i18next";
import { Square, SquareArrowOutUpRight } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun } from "../../../shared/claude/activity";
import { shortId } from "../../../shared/util/short-id";
import { toolCount } from "../agent-list/agent-flow";
import {
  AgentDuration,
  AgentGlyph,
  agentStateColor,
  agentStateLabel,
} from "../agent-list/agent-status";
import { Button } from "../ui/button";
import { tooltipProps } from "../ui/tooltip";

export function runKindParts(run: AgentRun): string[] {
  const parts =
    run.kind === "print"
      ? [
          i18next.t(
            run.program === "codex" ? "common:chat.run.kind_codex" : "common:chat.run.kind",
          ),
          run.model,
          run.endpoint,
          run.sessionId === undefined ? undefined : shortId(run.sessionId),
          run.toolsTold ? toolCount(run) : undefined,
        ]
      : [
          run.type,
          run.background ? i18next.t("common:agentList.agents.background") : undefined,
          run.model,
          shortId(run.id),
          toolCount(run),
        ];
  return parts.filter((part): part is string => part !== undefined && part !== "");
}

export function RunHeader({
  run,
  title,
  actions,
  className,
}: {
  run: AgentRun;
  title?: string;
  actions?: ReactNode;
  className?: string;
}) {
  const kind = runKindParts(run).join(" · ");
  return (
    <header
      className={cn("flex shrink-0 gap-3", title ? "items-start" : "items-center", className)}
      data-testid="run-header"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title && <h2 className="break-words text-app-body-emphasis text-foreground">{title}</h2>}
        {kind && (
          <span
            className="truncate font-mono text-app-micro text-muted-foreground"
            {...tooltipProps(kind)}
          >
            {kind}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-app-ui-sm">
          <AgentGlyph state={run.state} />
          <span className={agentStateColor(run.state)}>{agentStateLabel(run.state)}</span>
          <AgentDuration agent={run} className="text-app-ui-sm" />
        </span>
        {actions}
      </div>
    </header>
  );
}

export function RunOpenButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button size="icon-sm" variant="outline" tooltip={label} onClick={onClick}>
      <SquareArrowOutUpRight aria-hidden className="size-3.5" />
    </Button>
  );
}

export function RunStopButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button size="icon-sm" variant="outline" tooltip={t("chat.run.stop")} onClick={onClick}>
      <Square aria-hidden className="size-3 fill-current text-(--state-error-fg)" />
    </Button>
  );
}
