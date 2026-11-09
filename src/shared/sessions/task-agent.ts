/**
 * What a new task opens with: a Claude or Codex tab that takes the task's
 * prompt as its first message, or a terminal with a plain shell.
 */

export const TASK_AGENTS = ["claude", "codex", "terminal"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];

/** The agents a task's prompt goes to, in a chat tab of their own. */
export type ChatAgent = Exclude<TaskAgent, "terminal">;

export const DEFAULT_TASK_AGENT: TaskAgent = "claude";

/**
 * The conversation the agents tab's [+] opens for the default agent: its
 * own, or Claude's when it is a terminal, which is no conversation.
 */
export function chatAgentOf(agent: TaskAgent): ChatAgent {
  return agent === "codex" ? "codex" : "claude";
}

/** A stored task agent, or undefined when it is none this version has. */
export function asTaskAgent(value: string | undefined): TaskAgent | undefined {
  return TASK_AGENTS.find((agent) => agent === value);
}

/**
 * The task agent for the command earlier versions ran in a new task's
 * terminal: codex's for a codex command, a terminal for none, else Claude's.
 */
export function taskAgentOfCommand(command: string): TaskAgent {
  const trimmed = command.trim();
  if (trimmed === "") return "terminal";
  // PowerShell runs a program at a quoted path by its call operator.
  const rest = trimmed.replace(/^&\s*/, "");
  const quoted = /^(["'])(.*?)\1/.exec(rest);
  const program = quoted ? quoted[2] : (rest.split(/\s+/)[0] ?? "");
  return /(^|[\\/])codex(\.exe|\.cmd|\.bat|\.ps1)?$/i.test(program) ? "codex" : "claude";
}
