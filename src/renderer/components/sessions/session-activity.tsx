// Sessions tab — what a Claude session's detail panel tells of its turn, as
// its hooks record it (claude.activity): the tool it runs now and the turn
// so far, its todo list, the agents it runs, and the tools it ran.

import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, Loader } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { AgentRun, SessionActivity, Todo } from "../../../shared/claude/activity";
import { currentTool, endedAgents, liveAgents, toolLine } from "../../services/sessions/agents";
import type { AgentSession } from "../../services/sessions/model";
import { AgentLines, agentLabel, elapsedLabel } from "./agent-status";
import type { SessionsSelection } from "./selection";
import { ToolList } from "./tool-list";
import { rowClass } from "./tree-view";

/**
 * The tool the turn runs now, with how long it has run, or what it asks
 * permission for; over the turn so far: how long, how many tools, files
 * written and agents running.
 */
export function NowCard({
  session,
  activity,
  now,
}: {
  session: AgentSession;
  activity: SessionActivity;
  now: number;
}) {
  const { t } = useTranslation();
  const working = session.state === "running" || session.state === "permissionPending";
  const tool = working ? currentTool(activity.tools) : undefined;
  // The session waits on the agent that asks, if one does; else on its own tool.
  const asking =
    session.state === "permissionPending"
      ? activity.agents.find((agent) => agent.state === "permissionPending")
      : undefined;
  // What it asks for: the asking agent's tool, else the session's own.
  const asked = asking ? currentTool(asking.tools) : tool;
  // A request held for an answer shows below, with its buttons.
  const held = (activity.asks?.length ?? 0) > 0;
  // A turn that ended lasted until its state changed.
  const turnEnd = working ? now : session.since;
  const turn =
    activity.turnStart !== undefined && turnEnd !== undefined && turnEnd >= activity.turnStart
      ? elapsedLabel(turnEnd - activity.turnStart)
      : undefined;
  const running = liveAgents(activity.agents).length;
  const stats = [
    turn && t("sessions.detail.turn", { duration: turn }),
    activity.failedCount > 0
      ? t("sessions.agents.tools_failed", {
          count: activity.toolCount,
          failed: activity.failedCount,
        })
      : t("sessions.agents.tools", { count: activity.toolCount }),
    activity.files.length > 0 &&
      t("sessions.detail.files_written", { count: activity.files.length }),
    running > 0 && t("sessions.detail.agents_running", { count: running }),
  ].filter((part): part is string => typeof part === "string");
  return (
    <div className="flex flex-col gap-2 rounded-(--radius-raised) border border-border bg-muted p-3">
      {held ? null : session.state === "permissionPending" ? (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2 text-app-body-emphasis text-(--state-warning-fg)">
            <CircleAlert aria-hidden className="size-3 shrink-0" />
            <span className="truncate">
              {asking
                ? t("sessions.agents.asking_agent", { name: agentLabel(asking) })
                : t("sessions.agents.state.permissionPending")}
            </span>
          </span>
          {asked && (
            <span
              className="truncate pl-5 font-mono text-app-ui-sm text-foreground"
              title={asked.target}
            >
              {toolLine(asked)}
            </span>
          )}
        </span>
      ) : (
        working && (
          <span className="flex min-w-0 items-center gap-2">
            <Loader
              aria-hidden
              className="size-3 shrink-0 text-emerald-500 motion-safe:animate-spin"
            />
            {tool ? (
              <>
                <span className="shrink-0 text-app-body-emphasis text-foreground">{tool.name}</span>
                <span
                  className="min-w-0 flex-1 truncate font-mono text-app-ui-sm text-foreground"
                  title={tool.target}
                >
                  {tool.target?.split("\n")[0] ?? ""}
                </span>
                <span className="shrink-0 text-app-micro text-emerald-500">
                  {t("sessions.agents.detail.running_for", {
                    duration: elapsedLabel(now - tool.start),
                  })}
                </span>
              </>
            ) : (
              <span className="text-app-ui-sm text-muted-foreground">
                {t("sessions.detail.now_thinking")}
              </span>
            )}
          </span>
        )
      )}
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-app-micro text-muted-foreground">
        {stats.map((stat) => (
          <span key={stat}>{stat}</span>
        ))}
      </span>
    </div>
  );
}

/** The turn's todo list, with how much of it is done. */
export function TodoSection({ todos }: { todos: readonly Todo[] }) {
  const { t } = useTranslation();
  if (todos.length === 0) return null;
  const done = todos.filter((todo) => todo.status === "completed").length;
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle
        title={t("sessions.detail.todos")}
        aside={t("sessions.detail.todos_progress", { done, total: todos.length })}
      />
      <span aria-hidden className="block h-1 rounded-full bg-border">
        <span
          className="block h-1 rounded-full bg-(--tab-claude-attention-fg)"
          style={{ width: `${(done / todos.length) * 100}%` }}
        />
      </span>
      <ul className="flex flex-col gap-1">
        {todos.map((todo, index) => (
          <li
            // A TodoWrite list has no ids, and may say the same twice; it is
            // replaced whole, never reordered.
            key={todo.id ?? index}
            className={cn(
              "flex min-w-0 items-center gap-2 text-app-ui-sm",
              todo.status === "in_progress" ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <TodoGlyph status={todo.status} />
            <span className={cn("truncate", todo.status === "completed" && "line-through")}>
              {todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TodoGlyph({ status }: { status: Todo["status"] }) {
  const Icon = status === "completed" ? CircleCheck : status === "in_progress" ? CircleDot : Circle;
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-3 shrink-0",
        status === "completed"
          ? "text-(--tab-claude-attention-fg)"
          : status === "in_progress"
            ? "text-emerald-500"
            : "text-muted-foreground",
      )}
    />
  );
}

/** The agents the session runs; the ended ones fold away until opened. */
export function AgentsSection({
  session,
  agents,
  onSelect,
}: {
  session: AgentSession;
  agents: readonly AgentRun[];
  onSelect: (selection: SessionsSelection) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (agents.length === 0) return null;
  const live = liveAgents(agents);
  const ended = endedAgents(agents);
  const asking = live.filter((agent) => agent.state === "permissionPending").length;
  const counts = [
    live.length - asking > 0 && t("sessions.agents.count_running", { count: live.length - asking }),
    asking > 0 && t("sessions.agents.count_asking", { count: asking }),
    ended.length > 0 && t("sessions.agents.count_ended", { count: ended.length }),
  ].filter((part): part is string => typeof part === "string");
  const row = (agent: AgentRun) => (
    <button
      key={agent.id}
      type="button"
      onClick={() => onSelect({ kind: "agent", key: session.key, agentId: agent.id })}
      className={cn(rowClass(false), "flex-col gap-0.5 py-1.5")}
    >
      <AgentLines agent={agent} dim={agent.end !== undefined} />
    </button>
  );
  return (
    <section className="flex flex-col gap-1.5">
      <SectionTitle title={t("sessions.detail.agents")} aside={counts.join(" · ")} />
      <div className="flex flex-col gap-0.5 rounded-(--radius-control) border border-border p-1">
        {live.map(row)}
        {ended.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            className="flex w-full min-w-0 items-center gap-1 rounded-(--radius-control) px-2 py-1 text-left text-app-micro text-muted-foreground transition-colors hover:bg-[var(--state-hover-bg)]"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            />
            {t("sessions.agents.ended_toggle", { count: ended.length })}
          </button>
        )}
        {open && ended.map(row)}
      </div>
    </section>
  );
}

/** The tools the session's turn ran, the latest first. */
export function ProgressSection({ activity, now }: { activity: SessionActivity; now: number }) {
  const { t } = useTranslation();
  if (activity.tools.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <SectionTitle
        title={t("sessions.detail.progress")}
        aside={
          activity.failedCount > 0
            ? t("sessions.agents.tools_failed", {
                count: activity.toolCount,
                failed: activity.failedCount,
              })
            : t("sessions.agents.tools", { count: activity.toolCount })
        }
      />
      <ToolList tools={activity.tools} now={now} />
    </section>
  );
}

export function SectionTitle({ title, aside }: { title: string; aside?: string }) {
  return (
    <h3 className="flex items-baseline justify-between gap-2 text-app-label uppercase text-muted-foreground">
      <span>{title}</span>
      {aside && <span className="truncate normal-case">{aside}</span>}
    </h3>
  );
}
