export const TASK_AGENTS = ["claude", "codex", "terminal"] as const;
export type TaskAgent = (typeof TASK_AGENTS)[number];

export type ChatAgent = Exclude<TaskAgent, "terminal">;

export const DEFAULT_TASK_AGENT: TaskAgent = "claude";

export function chatAgentOf(agent: TaskAgent): ChatAgent {
  return agent === "codex" ? "codex" : "claude";
}

export function asTaskAgent(value: string | undefined): TaskAgent | undefined {
  return TASK_AGENTS.find((agent) => agent === value);
}

export function taskAgentOfCommand(command: string): TaskAgent {
  const trimmed = command.trim();
  if (trimmed === "") return "terminal";
  const rest = trimmed.replace(/^&\s*/, "");
  const quoted = /^(["'])(.*?)\1/.exec(rest);
  const program = quoted ? quoted[2] : (rest.split(/\s+/)[0] ?? "");
  return /(^|[\\/])codex(\.exe|\.cmd|\.bat|\.ps1)?$/i.test(program) ? "codex" : "claude";
}
