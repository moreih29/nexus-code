// What an agent a session runs did, as its session's own turn reads in its
// tab: what it was asked on the right, then what it wrote and the tools it
// ran, in order, and its answer last. Shown for a subagent, a `claude -p`
// run and a `codex exec` run alike, in the agents tab and in a tab's pane.

import i18next from "i18next";
import { Ban, Check, LoaderCircle, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun, ToolRun } from "../../../shared/claude/activity";
import { agentFlow, runMessages } from "../../services/sessions/agents";
import { toolTint } from "../chat/tool-row";
import { elapsedLabel } from "./agent-status";

/** How many of the latest steps show before the earlier ones are opened. */
const STEPS_SHOWN = 20;

/** How many lines of the request show before it is opened. */
const PROMPT_LINES = 6;

export function AgentFlow({
  agent,
  now,
  renderText = plainText,
}: {
  agent: AgentRun;
  /** For the seconds a running tool counts. */
  now: number;
  /** How what it wrote reads: as is, or as markdown in a tab. */
  renderText?: (text: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  // A subagent's tools are its hooks'; a run tells them once it is read.
  const told = agent.kind === "subagent" || agent.toolsTold;
  const steps = agentFlow(agent.tools, runMessages(agent));
  const hidden = all ? 0 : Math.max(0, steps.length - STEPS_SHOWN);
  const running = agent.end === undefined;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {agent.prompt && <PromptBubble key={agent.id} text={agent.prompt} />}
      {!told ? (
        <p className="text-app-ui-sm text-muted-foreground">
          {agent.program === "codex"
            ? t("sessions.agents.detail.tools_untold_codex")
            : t("sessions.agents.detail.tools_untold")}
        </p>
      ) : (
        steps.length > 0 && (
          <div className="flex min-w-0 flex-col gap-1">
            {steps.length > STEPS_SHOWN && (
              <button
                type="button"
                onClick={() => setAll(!all)}
                className="self-start rounded-(--radius-control) px-1.5 text-app-micro text-muted-foreground transition-colors hover:text-foreground"
              >
                {all
                  ? t("sessions.agents.detail.fewer_tools")
                  : t("sessions.agents.detail.more_tools", { count: hidden })}
              </button>
            )}
            {steps.slice(hidden).map((step) =>
              "tool" in step ? (
                <ToolStep key={step.key} tool={step.tool} now={now} />
              ) : (
                <div key={step.key} className="min-w-0 px-1.5 py-1">
                  {renderText(step.message.text)}
                </div>
              ),
            )}
          </div>
        )
      )}
      {agent.answer ? (
        <div className="min-w-0 px-1.5">{renderText(agent.answer)}</div>
      ) : (
        <p className="px-1.5 text-app-ui-sm text-muted-foreground">
          {running
            ? t(
                agent.kind === "print"
                  ? "sessions.agents.detail.answer_pending_run"
                  : "sessions.agents.detail.answer_pending",
              )
            : agent.exitCode !== undefined && agent.exitCode !== 0
              ? t("sessions.agents.exit_code", { code: agent.exitCode })
              : t("sessions.agents.detail.answer_none")}
        </p>
      )}
    </div>
  );
}

/** How many tools the agent ran, and how many failed. */
export function toolCount(agent: AgentRun): string {
  return agent.failedCount > 0
    ? i18next.t("common:sessions.agents.tools_failed", {
        count: agent.toolCount,
        failed: agent.failedCount,
      })
    : i18next.t("common:sessions.agents.tools", { count: agent.toolCount });
}

function plainText(text: string): ReactNode {
  return (
    <p className="whitespace-pre-wrap break-words text-app-body text-foreground select-text">
      {text}
    </p>
  );
}

/** What it was asked, on the right as a request in its tab, folded when long. */
function PromptBubble({ text }: { text: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const long = text.length > 400 || text.split("\n").length > PROMPT_LINES;
  return (
    <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
      <div className="max-w-full rounded-(--radius-raised) bg-[var(--chat-user-bg)] px-3 py-2">
        <p
          className={cn(
            "whitespace-pre-wrap break-words text-app-body text-foreground select-text",
            long && !open && "line-clamp-6",
          )}
        >
          {text}
        </p>
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="rounded-(--radius-control) text-app-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {open ? t("sessions.detail.answer_less") : t("sessions.detail.answer_more")}
        </button>
      )}
    </div>
  );
}

/** A tool it ran, as a call reads in its tab: how it went, its name and what it worked on. */
function ToolStep({ tool, now }: { tool: ToolRun; now: number }) {
  const { t } = useTranslation();
  const running = tool.end === undefined;
  const time = running
    ? t("sessions.agents.detail.running_for", { duration: elapsedLabel(now - tool.start) })
    : elapsedLabel((tool.end ?? tool.start) - tool.start);
  const target = tool.target?.split("\n")[0];
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-1.5 py-1 text-app-ui-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        <StepIcon tool={tool} />
        <span className={cn("shrink-0 font-medium", toolTint(tool.name))}>{tool.name}</span>
        {target && (
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={target}>
            {target}
          </span>
        )}
        {tool.denied && (
          <span className="shrink-0 text-muted-foreground">
            {t("sessions.agents.detail.denied")}
          </span>
        )}
        <span className="ml-auto shrink-0 text-app-micro text-muted-foreground tabular-nums">
          {time}
        </span>
      </div>
      {tool.note && (
        <span className="truncate pl-5 text-app-micro text-muted-foreground" title={tool.note}>
          {tool.note}
        </span>
      )}
      {tool.error && (
        <span
          className="truncate pl-5 font-mono text-app-micro text-(--state-error-fg)"
          title={tool.error}
        >
          {tool.error}
        </span>
      )}
    </div>
  );
}

function StepIcon({ tool }: { tool: ToolRun }) {
  const cls = "size-3.5 shrink-0";
  if (tool.end === undefined) {
    return tool.background ? (
      <LoaderCircle className={cn(cls, "text-muted-foreground")} />
    ) : (
      <LoaderCircle className={cn(cls, "animate-spin text-[var(--state-loading-indicator)]")} />
    );
  }
  if (tool.denied) return <Ban className={cn(cls, "text-muted-foreground")} />;
  if (tool.failed) return <X className={cn(cls, "text-[var(--state-error-fg)]")} />;
  return <Check className={cn(cls, "text-[var(--state-success-fg)]")} />;
}
