// Sessions tab — the tools a Claude session or one of its agents ran, the
// latest first: what each worked on, how long it took or has run, and why
// one failed. The older ones fold away.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ToolRun } from "../../../shared/claude/activity";
import { elapsedLabel } from "./agent-status";

/** How many of the latest tools show before the rest are opened. */
const TOOLS_SHOWN = 8;

export function ToolList({ tools, now }: { tools: readonly ToolRun[]; now: number }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const latest = [...tools].reverse();
  const shown = all ? latest : latest.slice(0, TOOLS_SHOWN);
  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col rounded-(--radius-control) border border-border">
        {shown.map((tool) => (
          <ToolRow key={tool.id} tool={tool} now={now} />
        ))}
      </ul>
      {latest.length > TOOLS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="self-start rounded-(--radius-control) px-1 text-app-micro text-muted-foreground transition-colors hover:text-foreground"
        >
          {all
            ? t("sessions.agents.detail.fewer_tools")
            : t("sessions.agents.detail.more_tools", { count: latest.length - TOOLS_SHOWN })}
        </button>
      )}
    </div>
  );
}

function ToolRow({ tool, now }: { tool: ToolRun; now: number }) {
  const { t } = useTranslation();
  const running = tool.end === undefined;
  const time = running
    ? t("sessions.agents.detail.running_for", { duration: elapsedLabel(now - tool.start) })
    : elapsedLabel((tool.end ?? tool.start) - tool.start);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-b border-border px-2 py-1 last:border-b-0">
      <span className="flex min-w-0 items-baseline gap-2">
        <span
          className={cn(
            "shrink-0 font-mono text-app-micro",
            tool.failed
              ? "text-(--state-error-fg)"
              : running
                ? "text-emerald-500"
                : "text-muted-foreground",
          )}
        >
          {tool.name}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-app-micro text-foreground"
          title={tool.target}
        >
          {tool.target?.split("\n")[0] ?? ""}
        </span>
        <span className="shrink-0 text-app-micro text-muted-foreground">{time}</span>
      </span>
      {tool.note && (
        <span className="truncate text-app-micro text-muted-foreground" title={tool.note}>
          {tool.note}
        </span>
      )}
      {tool.error && (
        <span
          className="truncate font-mono text-app-micro text-(--state-error-fg)"
          title={tool.error}
        >
          {tool.error}
        </span>
      )}
    </li>
  );
}
