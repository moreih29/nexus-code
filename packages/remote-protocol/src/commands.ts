export interface CodexClientCommand {
  name: string;
  aliases?: string[];
  argumentHint?: string;
}

export const CODEX_COMMANDS: readonly CodexClientCommand[] = [
  { name: "model" },
  { name: "effort" },
  { name: "plan" },
  { name: "default" },
  { name: "fast", argumentHint: "[on|off|status]" },
  { name: "config", aliases: ["settings"] },
  { name: "new", aliases: ["clear"] },
  { name: "resume", argumentHint: "[search]" },
  { name: "fork" },
  { name: "rename", argumentHint: "<name>" },
  { name: "compact" },
  { name: "review", argumentHint: "[instructions]" },
  { name: "init" },
  { name: "goal", argumentHint: "[<objective>|clear|pause|resume]" },
  { name: "status" },
  { name: "context" },
  { name: "usage" },
  { name: "diff" },
  { name: "copy", argumentHint: "[N]" },
  { name: "export", argumentHint: "[filename]" },
  { name: "mcp" },
  { name: "skills" },
  { name: "logout" },
  { name: "help" },
  { name: "exit", aliases: ["quit"] },
];

export const CODEX_REMOTE_COMMANDS: ReadonlySet<string> = new Set([
  "new",
  "compact",
  "fast",
  "plan",
  "default",
  "review",
  "init",
  "goal",
  "status",
  "rename",
  "fork",
  "export",
  "mcp",
  "skills",
]);
