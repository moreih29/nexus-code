/**
 * What a new task opens with: a Claude or Codex tab that takes the task's
 * prompt as its first message, or a terminal with a plain shell.
 */

export const TASK_AGENTS = ["claude", "codex", "terminal"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];

/** The agents a task's prompt goes to, in a chat tab of their own. */
export type ChatAgent = Exclude<TaskAgent, "terminal">;

export const DEFAULT_TASK_AGENT: TaskAgent = "claude";

/** A stored task agent, or undefined when it is none this version has. */
export function asTaskAgent(value: string | undefined): TaskAgent | undefined {
  return TASK_AGENTS.find((agent) => agent === value);
}

/**
 * The task agent for the command earlier versions ran in a new task's
 * terminal: codex's for a codex command, a terminal for none, else Claude's.
 */
export function taskAgentOfCommand(command: string): TaskAgent {
  const program = command.trim().split(/\s+/)[0] ?? "";
  if (program === "") return "terminal";
  return /(^|[\\/])codex(\.exe|\.cmd)?$/i.test(program) ? "codex" : "claude";
}
