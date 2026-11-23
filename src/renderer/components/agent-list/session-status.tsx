import i18next from "i18next";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  ListTodo,
  Loader,
  type LucideIcon,
  MessageCircleQuestion,
  Shield,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import type { ClaudeStatus } from "../../../shared/claude/status";
import { sharedClock, useSharedClock } from "../../hooks/use-now";
import type { AgentSession } from "../../services/agent-sessions/model";
import type { RowFacts, RowGroup } from "../../services/agent-sessions/rows";

interface StateLook {
  Icon: LucideIcon;
  colorClass: string;
  spin?: boolean;
}

function lookOf(state: string): StateLook {
  switch (state) {
    case "permissionPending":
      return { Icon: CircleAlert, colorClass: "text-(--state-warning-fg)" };
    case "needsInput":
      return { Icon: MessageCircleQuestion, colorClass: "text-(--tab-claude-attention-fg)" };
    case "error":
      return { Icon: TriangleAlert, colorClass: "text-(--state-error-fg)" };
    case "running":
    case "busy":
      return { Icon: Loader, colorClass: "text-emerald-500", spin: true };
    case "completed":
      return { Icon: CircleCheck, colorClass: "text-(--tab-claude-attention-fg)" };
    case "exited":
      return { Icon: CircleX, colorClass: "text-muted-foreground" };
    default:
      return { Icon: Circle, colorClass: "text-muted-foreground" };
  }
}

export function stateColor(state: string): string {
  return lookOf(state).colorClass;
}

export function stateLabel(session: Pick<AgentSession, "state" | "estimated">): string {
  const label = i18next.t(`common:agentList.state.${session.state}`, {
    defaultValue: session.state,
  });
  return session.estimated && session.state !== "exited"
    ? i18next.t("common:agentList.estimated", { label })
    : label;
}

export function estimatedLabel(status: string): string {
  return stateLabel({ state: status === "running" ? "busy" : status, estimated: true });
}

export function codexStatusLabel(status: ClaudeStatus): string {
  switch (status) {
    case "running":
      return i18next.t("common:codexStatus.running");
    case "completed":
      return i18next.t("common:codexStatus.completed");
    case "needsInput":
      return i18next.t("common:codexStatus.needsInput");
    case "permissionPending":
      return i18next.t("common:codexStatus.permissionPending");
    case "error":
      return i18next.t("common:codexStatus.error");
    case "idle":
      return i18next.t("common:codexStatus.idle");
  }
}

export function durationLabel(since: number | undefined, now: number): string | null {
  if (since === undefined) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return i18next.t("common:agentList.duration.now");
  if (minutes < 60) return i18next.t("common:agentList.duration.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18next.t("common:agentList.duration.hours", { count: hours });
  return i18next.t("common:agentList.duration.days", { count: Math.floor(hours / 24) });
}

export function StateGlyph({
  state,
  still,
  className,
}: {
  state: string;
  still?: boolean;
  className?: string;
}) {
  const { Icon, colorClass, spin: spins } = lookOf(state);
  const spin = spins && !still;
  return (
    <Icon
      aria-hidden
      width={12}
      height={12}
      strokeWidth={1.5}
      className={cn("shrink-0", colorClass, spin && "motion-safe:animate-spin", className)}
    />
  );
}

const durationClock = sharedClock(10_000);

export function useDurationLabel(since: number | undefined): string | null {
  const now = useSharedClock(durationClock);
  return durationLabel(since, Math.max(now, since ?? 0));
}

export function FailureLabel() {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 text-app-micro whitespace-nowrap text-(--state-error-fg)">
      {t("agentView.list.failed")}
    </span>
  );
}

export type WaitKind = "permission" | "question" | "plan";

const WAIT_ICONS: Record<WaitKind, LucideIcon> = {
  permission: Shield,
  question: MessageCircleQuestion,
  plan: ListTodo,
};

export function waitKindOf(
  session: Pick<AgentSession, "state">,
  facts: Pick<RowFacts, "wait">,
): WaitKind | undefined {
  const wait = facts.wait;
  if (wait?.kind === "question" || (!wait && session.state === "needsInput")) return "question";
  if (wait?.kind === "plan") return "plan";
  if (wait?.kind === "permission" || session.state === "permissionPending") return "permission";
  return undefined;
}

export function WaitSign({
  kind,
  label,
  testId,
}: {
  kind: WaitKind | undefined;
  label: string;
  testId?: string;
}) {
  const Icon = kind ? WAIT_ICONS[kind] : CircleAlert;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex"
      data-testid={testId}
      data-wait={kind}
    >
      <Icon
        aria-hidden
        width={12}
        height={12}
        strokeWidth={1.5}
        className="shrink-0 text-(--state-warning-fg)"
      />
    </span>
  );
}

export function SessionSign({
  session,
  facts,
  testId,
}: {
  session: Pick<AgentSession, "state" | "estimated" | "phase">;
  facts: Pick<RowFacts, "wait">;
  testId?: string;
}) {
  if (session.state === "error") return <FailureLabel />;
  const wait = session.phase === "attention" ? waitKindOf(session, facts) : undefined;
  if (wait)
    return (
      <WaitSign kind={wait} label={i18next.t(`common:agentList.wait.${wait}`)} testId={testId} />
    );
  const label = stateLabel(session);
  return (
    <span role="img" aria-label={label} title={label} className="inline-flex" data-testid={testId}>
      <StateGlyph state={session.state} />
    </span>
  );
}

export function HiddenSessionCount({ count }: { count: number }) {
  const { t } = useTranslation();
  return (
    <span className="shrink-0 text-app-micro whitespace-nowrap tabular-nums text-muted-foreground">
      {t("agentView.list.hidden", { count })}
    </span>
  );
}

export function AgentBadge({ agent }: { agent: string | undefined }) {
  return (
    <span className="shrink-0 rounded-(--radius-control) bg-muted px-1.5 font-mono text-app-micro text-muted-foreground">
      {agent ?? i18next.t("common:agentList.agent_unknown")}
    </span>
  );
}

export const GROUP_STATE: Record<RowGroup, string> = {
  attention: "permissionPending",
  running: "running",
  done: "completed",
  idle: "idle",
};

export const GROUP_TINT: Record<RowGroup, string> = {
  attention: "text-(--state-warning-fg)",
  running: "text-emerald-500",
  done: "text-(--tab-claude-attention-fg)",
  idle: "text-muted-foreground",
};
