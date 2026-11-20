/**
 * The permission modes of the app's Claude and Codex tabs: Claude Code's
 * own, and the presets a Codex tab offers. Shared: the composer's chip
 * lists them, and the nexus CLI changes them.
 */

import type { ChatAgent } from "./task-agent";

/** Permission modes as a chip lists them. */
export interface ModeSet {
  /** In the order the chip lists them, which keys 1 to n pick. */
  readonly modes: readonly string[];
  /** The one that lets everything run: listed apart, picked after a warning. */
  readonly dangerous: string;
  /** Where the labels are: `${prefix}.${mode}`, its `_hint`, and the warning's `bypass_confirm*`. */
  readonly prefix: string;
  /** The mode shown before the program tells one. */
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

/** Each agent's modes from the one that lets least run unasked to the one that lets most. */
const LEAST_TO_MOST: Readonly<Record<ChatAgent, readonly string[]>> = {
  claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  codex: ["readOnly", "auto", "fullAccess"],
};

/** The shared order when a Claude tab grants a mode to Codex or vice versa. */
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

/** Whether the caller's current mode covers a known mode in another tab. */
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

/** The mode a name gives, in any case; undefined for none of the agent's. */
export function chatModeNamed(agent: ChatAgent, name: string): string | undefined {
  const lower = name.trim().toLowerCase();
  return CHAT_MODES[agent].modes.find((mode) => mode.toLowerCase() === lower);
}

/** Whether going from mode `from` to mode `to` lets more run without asking. */
export function loosens(agent: ChatAgent, from: string, to: string): boolean {
  const order = LEAST_TO_MOST[agent];
  const at = (mode: string) => {
    const index = order.indexOf(mode);
    // A mode this version does not know counts as letting most run.
    return index < 0 ? order.length : index;
  };
  return at(to) > at(from);
}
