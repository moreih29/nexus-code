// Commands the Codex tab runs itself: Codex's slash commands, which its
// app-server leaves to the client, done with the server's requests or the
// tab's own views. Codex's terminal-only ones (theme, keymap, vim, pets,
// statusline…) are left out. Pure, for the tab and its tests.

import { type AppCommand, code, type Words } from "./app-commands";
import type { CodexModel } from "./codex-model";
import type { CommandInfo } from "./model";

export const CODEX_COMMANDS: readonly AppCommand[] = [
  { name: "model" },
  { name: "effort" },
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
  { name: "diff" },
  { name: "copy", argumentHint: "[N]" },
  { name: "export", argumentHint: "[filename]" },
  { name: "mcp" },
  { name: "skills" },
  { name: "logout" },
  { name: "help" },
  { name: "exit", aliases: ["quit"] },
];

function namesOf(command: AppCommand): string[] {
  return [command.name, ...(command.aliases ?? [])];
}

/** The commands as the composer's `/` menu lists them. */
export function codexCommandsListed(describe: (name: string) => string): CommandInfo[] {
  return CODEX_COMMANDS.map((c) => ({
    name: c.name,
    aliases: c.aliases,
    argumentHint: c.argumentHint,
    description: describe(c.name),
  }));
}

const COMMAND_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/** The command a message calls, and what follows it; null for a message to send. */
export function parseCodexCommand(text: string): { name: string; args: string } | null {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return null;
  const typed = match[1].toLowerCase();
  const command = CODEX_COMMANDS.find((c) => namesOf(c).includes(typed));
  return command ? { name: command.name, args: (match[2] ?? "").trim() } : null;
}

/** What Codex's /init sends (codex-cli 0.167). */
export const CODEX_INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project's Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

/** What /review looks at: the uncommitted changes, or what the words given ask for. */
export function reviewTargetOf(
  args: string,
): { type: "uncommittedChanges" } | { type: "custom"; instructions: string } {
  const instructions = args.trim();
  return instructions ? { type: "custom", instructions } : { type: "uncommittedChanges" };
}

export type GoalCommand =
  | { kind: "show" }
  | { kind: "clear" }
  | { kind: "status"; status: "paused" | "active" }
  | { kind: "set"; objective: string };

/** /goal's words: show the goal, clear, pause or resume it, or set a new one. */
export function goalCommandOf(args: string): GoalCommand {
  const words = args.trim();
  switch (words.toLowerCase()) {
    case "":
      return { kind: "show" };
    case "clear":
      return { kind: "clear" };
    case "pause":
      return { kind: "status", status: "paused" };
    case "resume":
      return { kind: "status", status: "active" };
    default:
      return { kind: "set", objective: words };
  }
}

export interface ThreadGoal {
  objective: string;
  status: string;
  tokensUsed?: number;
  tokenBudget?: number;
}

/** thread/goal/get's goal, or null when the thread has none. */
export function goalOf(result: unknown): ThreadGoal | null {
  const goal = (result as { goal?: Record<string, unknown> | null } | null)?.goal;
  if (!goal || typeof goal.objective !== "string") return null;
  return {
    objective: goal.objective,
    status: typeof goal.status === "string" ? goal.status : "",
    tokensUsed: typeof goal.tokensUsed === "number" ? goal.tokensUsed : undefined,
    tokenBudget: typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined,
  };
}

export interface CodexMcpServer {
  name: string;
  /** connected, failed, notLoggedIn…: the connection's state, else the sign-in's. */
  status: string;
  tools: number;
}

/** mcpServerStatus/list's servers. */
export function mcpServersOf(result: unknown): CodexMcpServer[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((raw): CodexMcpServer[] => {
    const server = (raw ?? {}) as Record<string, unknown>;
    if (typeof server.name !== "string" || !server.name) return [];
    const runtime = typeof server.runtimeStatus === "string" ? server.runtimeStatus : undefined;
    const auth = typeof server.authStatus === "string" ? server.authStatus : "";
    const tools = server.tools && typeof server.tools === "object" ? server.tools : {};
    return [
      {
        name: server.name,
        status: runtime ?? (auth === "notLoggedIn" ? auth : ""),
        tools: Object.keys(tools).length,
      },
    ];
  });
}

export interface CodexSkill {
  name: string;
  description: string;
  /** user, repo, system, admin. */
  scope: string;
  path?: string;
  enabled: boolean;
}

/** skills/list's skills, each once though more than one folder lists it. */
export function codexSkillsOf(result: unknown): CodexSkill[] {
  const data = (result as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const skills: CodexSkill[] = [];
  for (const entry of data) {
    const list = (entry as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const skill = (raw ?? {}) as Record<string, unknown>;
      if (typeof skill.name !== "string" || !skill.name) continue;
      const path = typeof skill.path === "string" && skill.path ? skill.path : undefined;
      const key = path ?? skill.name;
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({
        name: skill.name,
        description: typeof skill.description === "string" ? skill.description : "",
        scope: typeof skill.scope === "string" ? skill.scope : "",
        path,
        enabled: skill.enabled !== false,
      });
    }
  }
  return skills;
}

/** /status: the thread's settings and what it has used, as Markdown lines. */
export function codexStatusMarkdown(model: CodexModel, cwd: string, t: Words): string {
  const rows: [string, string | undefined][] = [
    [t("chat.codex.commands.status.model"), model.model],
    [t("chat.codex.commands.status.effort"), model.effort],
    [t("chat.codex.commands.status.folder"), code(model.cwd ?? cwd)],
    [t("chat.codex.commands.status.thread"), model.threadId ? code(model.threadId) : undefined],
    [t("chat.codex.commands.status.version"), model.version],
    [
      t("chat.codex.commands.status.account"),
      model.account
        ? model.account.type
        : model.account === null
          ? t("chat.codex.commands.status.signed_out")
          : undefined,
    ],
    [
      t("chat.codex.commands.status.context"),
      model.tokens
        ? model.tokens.window
          ? `${model.tokens.used.toLocaleString()} / ${model.tokens.window.toLocaleString()}`
          : model.tokens.used.toLocaleString()
        : undefined,
    ],
  ];
  return rows
    .filter((row): row is [string, string] => Boolean(row[1]))
    .map(([label, value]) => `- **${label}** ${value}`)
    .join("\n");
}
