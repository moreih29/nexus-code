import {
  type AssistantItem,
  type ChatItem,
  type CommandInfo,
  opensTurn,
  type ToolCall,
} from "./model";
import { relaySenderText } from "./relayed";
import type { RevealPart } from "./store";

export interface AppCommand {
  name: string;
  aliases?: string[];
  argumentHint?: string;
}

export const APP_COMMANDS: readonly AppCommand[] = [
  { name: "btw", argumentHint: "<question>" },
  { name: "copy", argumentHint: "[N]" },
  { name: "export", argumentHint: "[filename]" },
  { name: "diff" },
  { name: "status" },
  { name: "memory" },
  { name: "permissions", aliases: ["allowed-tools"] },
  { name: "plan", argumentHint: "[open|<description>]" },
  { name: "add-dir", argumentHint: "<path>" },
  { name: "hooks" },
  { name: "sandbox", argumentHint: "[on|off]" },
  { name: "fork", argumentHint: "[prompt]" },
  { name: "branch", argumentHint: "[name]" },
  { name: "resume", argumentHint: "[search]" },
  { name: "remote-control", aliases: ["rc"] },
  { name: "subtask", argumentHint: "<task>" },
  { name: "tasks", aliases: ["bashes"] },
  { name: "workflows" },
  { name: "background", aliases: ["bg"], argumentHint: "[prompt]" },
  { name: "skills" },
  { name: "plugin", aliases: ["plugins", "marketplace"], argumentHint: "[install <plugin>]" },
  { name: "upgrade" },
  { name: "update" },
  { name: "release-notes" },
  { name: "feedback" },
  { name: "privacy-settings" },
  { name: "login" },
  { name: "logout" },
  { name: "teleport", aliases: ["tp"] },
  { name: "install-github-app" },
  { name: "install-slack-app" },
  { name: "setup-bedrock" },
  { name: "setup-vertex" },
  { name: "web-setup" },
  { name: "remote-env" },
  { name: "ultraplan", argumentHint: "<prompt>" },
  { name: "autofix-pr" },
  { name: "help" },
  { name: "exit", aliases: ["quit"] },
];

function namesOf(command: { name: string; aliases?: string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
}

const UNLISTED = new Set(["insights"]);

export function listedCommands(cli: readonly CommandInfo[]): CommandInfo[] {
  return cli.filter((c) => !UNLISTED.has(c.name.toLowerCase()));
}

export function appCommandsBeside(
  cli: readonly CommandInfo[],
  describe: (name: string) => string,
): CommandInfo[] {
  const taken = new Set(cli.flatMap(namesOf));
  return APP_COMMANDS.filter((c) => !namesOf(c).some((n) => taken.has(n))).map((c) => ({
    name: c.name,
    aliases: c.aliases,
    argumentHint: c.argumentHint,
    description: describe(c.name),
    builtin: true,
  }));
}

const COMMAND_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/;

export function parseAppCommand(
  text: string,
  cli: readonly CommandInfo[],
): { name: string; args: string } | null {
  const match = COMMAND_RE.exec(text.trim());
  if (!match) return null;
  const typed = match[1].toLowerCase();
  if (cli.some((c) => namesOf(c).includes(typed))) return null;
  const command = APP_COMMANDS.find((c) => namesOf(c).includes(typed));
  return command ? { name: command.name, args: (match[2] ?? "").trim() } : null;
}

const SHOWN_WHEN_BARE: Readonly<Record<string, RevealPart>> = {
  context: "context",
  usage: "usage",
  mcp: "mcp",
  model: "model",
  effort: "effort",
  changes: "changes",
};

export function revealOf(text: string, parts?: readonly RevealPart[]): RevealPart | null {
  const match = COMMAND_RE.exec(text.trim());
  if (!match || (match[2] ?? "").trim()) return null;
  const part = SHOWN_WHEN_BARE[match[1].toLowerCase()];
  return part && (!parts || parts.includes(part)) ? part : null;
}

export function answersOf(items: readonly ChatItem[]): string[] {
  const answers: string[] = [];
  let turn: AssistantItem[] = [];
  const close = () => {
    const text = turn
      .flatMap((item) => item.blocks.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])))
      .join("\n\n")
      .trim();
    if (text) answers.push(text);
    turn = [];
  };
  for (const item of items) {
    if (opensTurn(item)) close();
    else if (item.kind === "assistant") turn.push(item);
  }
  close();
  return answers;
}

export function nthAnswer(items: readonly ChatItem[], n: number): string | null {
  const answers = answersOf(items);
  return n >= 1 && n <= answers.length ? answers[answers.length - n] : null;
}

export function copyIndex(args: string): number | null {
  if (!args) return 1;
  return /^[1-9]\d*$/.test(args) ? Number(args) : null;
}

export function conversationMarkdown(
  items: readonly ChatItem[],
  tools: Readonly<Record<string, ToolCall>>,
  summarize: (tool: ToolCall) => string,
  labels: { user: string; assistant: string },
): string {
  const parts: string[] = [];
  let speaker: "user" | "assistant" | null = null;
  for (const item of items) {
    if (item.kind === "received") {
      if (!item.text.trim()) continue;
      const relayed = relaySenderText(item.from);
      const from = relayed
        ? `from ${relayed}`
        : item.from.name
          ? `${item.from.kind}: ${item.from.name}`
          : item.from.kind;
      parts.push(`## ${from}\n\n${item.text.trim()}`);
      speaker = "user";
      continue;
    }
    if (item.kind === "shell") {
      const out = [item.stdout, item.stderr].filter(Boolean).join("\n");
      parts.push(`\`\`\`\n$ ${item.command}${out ? `\n${out}` : ""}\n\`\`\``);
      speaker = null;
      continue;
    }
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    if (item.kind === "user") {
      if (!item.text.trim()) continue;
      parts.push(`## ${labels.user}\n\n${item.text.trim()}`);
      speaker = "user";
      continue;
    }
    const lines: string[] = [];
    for (const block of item.blocks) {
      if (block.type === "text" && block.text.trim()) lines.push(block.text.trim());
      else if (block.type === "tool") {
        const tool = tools[block.toolUseId];
        if (!tool || tool.parentToolUseId) continue;
        const summary = summarize(tool);
        lines.push(summary ? `- **${tool.name}** ${code(summary)}` : `- **${tool.name}**`);
      }
    }
    if (lines.length === 0) continue;
    if (speaker !== "assistant") parts.push(`## ${labels.assistant}`);
    parts.push(lines.join("\n\n"));
    speaker = "assistant";
  }
  return `${parts.join("\n\n")}\n`;
}

export function exportFileName(items: readonly ChatItem[], now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const first = items.find((item) => item.kind === "user" && item.text.trim());
  const slug =
    first?.kind === "user"
      ? first.text
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40)
          .replace(/-+$/, "")
      : "";
  return `${stamp}${slug ? `-${slug}` : ""}.md`;
}

export function exportRelPath(name: string, cwd: string, rootPath: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) return null;
  const parts = trimmed.split(/[\\/]+/);
  if (parts.some((p) => p === ".." || p === "")) return null;
  const root = rootPath.replace(/\/+$/, "");
  const folder = cwd.replace(/\/+$/, "");
  if (folder !== root && !folder.startsWith(`${root}/`)) return null;
  const under = folder.slice(root.length).replace(/^\//, "");
  return [under, ...parts].filter(Boolean).join("/");
}

export type Words = (key: string, options?: Record<string, unknown>) => string;

export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function directoryArg(arg: string, cwd: string): string | null {
  const path = arg.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!path) return null;
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}

export function branchTitle(name: string, title: string | undefined): string | undefined {
  const given = name.trim();
  if (given) return given;
  return title?.trim() ? `${title.trim()} (Branch)` : undefined;
}

export function subtaskPrompt(task: string): string {
  return `Use the Agent tool with subagent_type "fork" for the task below, and tell me its result.\n\n${task}`;
}

export const COMMAND_LINKS: Readonly<Record<string, string>> = {
  upgrade: "https://claude.ai/upgrade",
  "release-notes": "https://code.claude.com/docs/en/changelog",
  feedback: "https://github.com/anthropics/claude-code/issues",
  "privacy-settings": "https://claude.ai/settings/data-privacy-controls",
};

export function terminalCommandOf(
  name: string,
  args: string,
): { command: string; argument: string } | null {
  switch (name) {
    case "login":
      return { command: "claude auth login", argument: "" };
    case "logout":
      return { command: "claude auth logout", argument: "" };
    case "update":
      return { command: "claude update", argument: "" };
    case "teleport":
      return { command: "claude --teleport", argument: "" };
    case "install-github-app":
    case "install-slack-app":
    case "setup-bedrock":
    case "setup-vertex":
    case "web-setup":
    case "remote-env":
    case "ultraplan":
    case "autofix-pr":
      return { command: "claude", argument: `/${name}${args ? ` ${args}` : ""}` };
    default:
      return null;
  }
}

export const RESTART_AFTER = new Set(["login", "logout", "update"]);

export interface SkillInfo {
  name: string;
  source: string;
  path?: string;
  tokens?: number;
}

export function skillsOf(usage: unknown): SkillInfo[] {
  const skills = (usage as { skills?: { skillFrontmatter?: unknown } } | null)?.skills;
  const list = skills?.skillFrontmatter;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): SkillInfo[] => {
    const skill = raw as Record<string, unknown> | null;
    if (typeof skill?.name !== "string" || !skill.name) return [];
    const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return [
      {
        name: skill.name,
        source: text(skill.pluginName) ?? text(skill.source) ?? "",
        path: text(skill.path),
        tokens: typeof skill.tokens === "number" ? skill.tokens : undefined,
      },
    ];
  });
}
