import type { ChatAgent } from "./task-agent";

export interface ModeSet {
  readonly modes: readonly string[];
  readonly dangerous: string;
  readonly prefix: string;
  readonly fallback: string;
}

export const CHAT_MODES: Readonly<Record<ChatAgent, ModeSet>> = {
  claude: {
    modes: ["auto", "default", "acceptEdits", "plan", "bypassPermissions"],
    dangerous: "bypassPermissions",
    prefix: "chat.mode",
    fallback: "default",
  },
  codex: {
    modes: ["readOnly", "auto", "fullAccess"],
    dangerous: "fullAccess",
    prefix: "chat.codex.mode",
    fallback: "auto",
  },
};

const LEAST_TO_MOST: Readonly<Record<ChatAgent, readonly string[]>> = {
  claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  codex: ["readOnly", "auto", "fullAccess"],
};

const CROSS_AGENT_RANK: Readonly<Record<ChatAgent, ReadonlyMap<string, number>>> = {
  claude: new Map([
    ["plan", 0],
    ["default", 0],
    ["acceptEdits", 1],
    ["auto", 1],
    ["bypassPermissions", 2],
  ]),
  codex: new Map([
    ["readOnly", 0],
    ["auto", 1],
    ["fullAccess", 2],
  ]),
};

export function grants(
  callerAgent: ChatAgent,
  callerMode: string | undefined,
  agent: ChatAgent,
  mode: string,
): boolean {
  if (callerAgent === agent) {
    const order = LEAST_TO_MOST[agent];
    const target = order.indexOf(mode);
    return target >= 0 && Math.max(0, order.indexOf(callerMode ?? "")) >= target;
  }
  const rank = CROSS_AGENT_RANK[agent].get(mode);
  return rank !== undefined && (CROSS_AGENT_RANK[callerAgent].get(callerMode ?? "") ?? 0) >= rank;
}

export function chatModeNamed(agent: ChatAgent, name: string): string | undefined {
  const lower = name.trim().toLowerCase();
  return CHAT_MODES[agent].modes.find((mode) => mode.toLowerCase() === lower);
}

export function loosens(agent: ChatAgent, from: string, to: string): boolean {
  const order = LEAST_TO_MOST[agent];
  const at = (mode: string) => {
    const index = order.indexOf(mode);
    return index < 0 ? order.length : index;
  };
  return at(to) > at(from);
}
