import i18next from "i18next";
import {
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CircleX,
  Loader,
  type LucideIcon,
  MessageCircleQuestion,
  TriangleAlert,
} from "lucide-react";
import type { SessionState } from "../../../../packages/remote-protocol/src/rpc";
import type { AgentRunState } from "../../../shared/claude/activity";
import type { ClaudeStatus } from "../../../shared/claude/status";
import type { RowGroup } from "../../services/agent-sessions/rows";

export interface StateLook {
  Icon: LucideIcon;
  colorClass: string;
  spin?: boolean;
  pulse?: boolean;
  labelKey: string;
}

const WARNING = "text-(--state-warning-fg)";
const ATTENTION = "text-(--tab-claude-attention-fg)";
const ERROR = "text-(--state-error-fg)";
const WORKING = "text-emerald-500";
const MUTED = "text-muted-foreground";

function stateKey(state: string): string {
  return `common:agentList.state.${state}`;
}

const SESSION_LOOKS: Readonly<Record<string, Omit<StateLook, "labelKey">>> = {
  permissionPending: { Icon: CircleAlert, colorClass: WARNING },
  needsInput: { Icon: MessageCircleQuestion, colorClass: ATTENTION, pulse: true },
  error: { Icon: TriangleAlert, colorClass: ERROR },
  running: { Icon: Loader, colorClass: WORKING, spin: true },
  busy: { Icon: Loader, colorClass: WORKING, spin: true },
  completed: { Icon: CircleCheck, colorClass: ATTENTION },
  exited: { Icon: CircleX, colorClass: MUTED },
};

const IDLE_LOOK = { Icon: Circle, colorClass: MUTED };

export function stateLook(state: string): StateLook {
  return { ...(SESSION_LOOKS[state] ?? IDLE_LOOK), labelKey: stateKey(state) };
}

const RUN_LOOKS: Readonly<Record<AgentRunState, Omit<StateLook, "labelKey">>> = {
  running: { Icon: Loader, colorClass: WORKING, spin: true },
  permissionPending: { Icon: CircleAlert, colorClass: WARNING },
  completed: { Icon: CircleCheck, colorClass: ATTENTION },
  failed: { Icon: CircleX, colorClass: ERROR },
  stopped: { Icon: CircleSlash, colorClass: MUTED },
};

export function runLook(state: AgentRunState): StateLook {
  return {
    ...(RUN_LOOKS[state] ?? RUN_LOOKS.stopped),
    labelKey: `common:agentList.agents.state.${state}`,
  };
}

export const GROUP_STATE: Readonly<Record<RowGroup, string>> = {
  attention: "permissionPending",
  running: "running",
  done: "completed",
  idle: "idle",
};

export const GROUP_TINT: Readonly<Record<RowGroup, string>> = {
  attention: stateLook(GROUP_STATE.attention).colorClass,
  running: stateLook(GROUP_STATE.running).colorClass,
  done: stateLook(GROUP_STATE.done).colorClass,
  idle: stateLook(GROUP_STATE.idle).colorClass,
};

export const REMOTE_STATE: Readonly<Record<SessionState, string>> = {
  "needs-you": "needsInput",
  running: "running",
  "new-result": "completed",
  idle: "idle",
  ended: "exited",
};

export function remoteStateLook(state: SessionState): StateLook {
  const look = stateLook(REMOTE_STATE[state] ?? "idle");
  if (state !== "needs-you") return look;
  return { ...stateLook(GROUP_STATE.attention), labelKey: look.labelKey };
}

export function stateText(state: string): string {
  return i18next.t(stateKey(state), { defaultValue: state });
}

export function programStateLabel(program: "claude" | "codex", state: ClaudeStatus): string {
  return i18next.t("common:agentList.state_of", {
    agent: program === "codex" ? "Codex" : "Claude",
    state: stateText(state),
  });
}
