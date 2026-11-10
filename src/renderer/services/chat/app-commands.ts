// Commands the Claude tab runs itself: Claude Code's built-ins that its
// headless mode lacks (/copy, /btw, /memory…), done in the GUI. A command
// the CLI lists under the same name is the CLI's, so a Claude Code that
// gains one runs its own. Pure, for the tab and its tests.

import {
  type AssistantItem,
  type ChatItem,
  type CommandInfo,
  opensTurn,
  type ToolCall,
} from "./model";
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
  { name: "ultrareview", argumentHint: "[PR]" },
  { name: "ultraplan", argumentHint: "<prompt>" },
  { name: "autofix-pr" },
  { name: "help" },
  { name: "exit", aliases: ["quit"] },
];

function namesOf(command: { name: string; aliases?: string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
}

/**
 * The CLI's commands the `/` menu leaves out: /insights shows nothing in a
 * headless run, and the app makes no screen for it. Typed out, it still goes
 * to the CLI.
 */
const UNLISTED = new Set(["insights"]);

/** The CLI's commands as the composer's list shows them. */
export function listedCommands(cli: readonly CommandInfo[]): CommandInfo[] {
  return cli.filter((c) => !UNLISTED.has(c.name.toLowerCase()));
}

/** The app's commands that the CLI does not have, described for the composer's list. */
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
  }));
}

const COMMAND_RE = /^\/(\S+)(?:\s+([\s\S]*))?$/;

/** The app command a message calls, and what follows it; null for a message to send. */
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

/**
 * The CLI's commands that, typed with nothing after them, the tab answers
 * by showing its own view of the same thing rather than the CLI's text.
 */
const SHOWN_WHEN_BARE: Readonly<Record<string, RevealPart>> = {
  context: "context",
  usage: "usage",
  mcp: "mcp",
  model: "model",
  effort: "effort",
};

/** The part of the tab a bare command shows; null for one that has arguments, or another. */
export function revealOf(text: string, parts?: readonly RevealPart[]): RevealPart | null {
  const match = COMMAND_RE.exec(text.trim());
  if (!match || (match[2] ?? "").trim()) return null;
  const part = SHOWN_WHEN_BARE[match[1].toLowerCase()];
  return part && (!parts || parts.includes(part)) ? part : null;
}

/** What Claude said in each turn, oldest first: its text, without the tools. */
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

/** The Nth answer from the end (1: the last); null when there are fewer. */
export function nthAnswer(items: readonly ChatItem[], n: number): string | null {
  const answers = answersOf(items);
  return n >= 1 && n <= answers.length ? answers[answers.length - n] : null;
}

/** /copy's N: a whole number from 1, or 1 when none is given; null when it is not one. */
export function copyIndex(args: string): number | null {
  if (!args) return 1;
  return /^[1-9]\d*$/.test(args) ? Number(args) : null;
}

/** The conversation as Markdown: what was asked, what Claude said, and the tools it used. */
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
      const from = item.from.name ? `${item.from.kind}: ${item.from.name}` : item.from.kind;
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

/** Where /export writes when no name is given: the time, then the first message's words. */
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

/**
 * Where /export writes `name`, relative to the workspace root: under the
 * tab's folder; null for a name that leaves it, or a folder outside the root.
 */
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

/** The memory files get_context_usage reports: their paths and kinds. */
export function memoryFilesOf(usage: unknown): { path: string; type: string }[] {
  const files = (usage as { memoryFiles?: unknown } | null)?.memoryFiles;
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    const { path, type } = (file ?? {}) as { path?: unknown; type?: unknown };
    return typeof path === "string" && path
      ? [{ path, type: typeof type === "string" ? type : "" }]
      : [];
  });
}

/** Words a formatter takes from the tab's language. */
export type Words = (key: string, options?: Record<string, unknown>) => string;

/** Inline code that holds any text: a fence longer than the backticks in it. */
export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

interface PermissionRule {
  behavior: string;
  source: string;
  rule: string;
  notInEffect?: boolean;
}

/** list_permission_rules' state: its rules and folders, as /permissions shows them. */
export function permissionsOf(body: unknown): {
  rules: PermissionRule[];
  directories: { path: string; source: string }[];
  cwd: string;
} {
  const state = ((body as { state?: unknown } | null)?.state ?? {}) as Record<string, unknown>;
  const rules = Array.isArray(state.rules)
    ? state.rules.flatMap((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return typeof r.rule === "string" && typeof r.behavior === "string"
          ? [
              {
                behavior: r.behavior,
                source: typeof r.source === "string" ? r.source : "",
                rule: r.rule,
                notInEffect: r.notInEffect === true,
              },
            ]
          : [];
      })
    : [];
  const directories = Array.isArray(state.workspaceDirectories)
    ? state.workspaceDirectories.flatMap((raw) => {
        const d = (raw ?? {}) as Record<string, unknown>;
        return typeof d.path === "string"
          ? [{ path: d.path, source: typeof d.source === "string" ? d.source : "" }]
          : [];
      })
    : [];
  return {
    rules,
    directories,
    cwd: typeof state.originalCwd === "string" ? state.originalCwd : "",
  };
}

const SOURCES = new Set([
  "userSettings",
  "projectSettings",
  "localSettings",
  "flagSettings",
  "policySettings",
  "cliArg",
  "command",
  "session",
]);

function sourceLabel(source: string, t: Words): string {
  return SOURCES.has(source) ? t(`chat.commands.source.${source}`) : source;
}

/** /permissions' card: the rules by what they do, then the folders Claude may work in. */
export function permissionsMarkdown(
  state: ReturnType<typeof permissionsOf>,
  t: Words,
  /** The folders /add-dir gave, which the CLI names as another source. */
  added: readonly string[] = [],
): string {
  const parts: string[] = [];
  for (const behavior of ["allow", "ask", "deny"]) {
    const rules = state.rules.filter((r) => r.behavior === behavior);
    if (rules.length === 0) continue;
    const lines = rules.map(
      (r) =>
        `- ${code(r.rule)} · ${sourceLabel(r.source, t)}${r.notInEffect ? ` · ${t("chat.commands.not_in_effect")}` : ""}`,
    );
    parts.push(`**${t(`chat.commands.behavior.${behavior}`)}**\n\n${lines.join("\n")}`);
  }
  if (parts.length === 0) parts.push(t("chat.commands.no_rules"));
  if (state.directories.length > 0) {
    const lines = state.directories.map(
      (d) =>
        `- ${code(d.path)} · ${added.includes(d.path) ? t("chat.commands.source.added") : sourceLabel(d.source, t)}`,
    );
    parts.push(`**${t("chat.commands.directories")}**\n\n${lines.join("\n")}`);
  }
  parts.push(t("chat.commands.permissions_edit"));
  return parts.join("\n\n");
}

/** The settings files whose rules /permissions lists, to open and edit. */
export function permissionFiles(state: ReturnType<typeof permissionsOf>): string[] {
  if (!state.cwd) return [];
  const root = state.cwd.replace(/\/+$/, "");
  const files: string[] = [];
  if (state.rules.some((r) => r.source === "projectSettings"))
    files.push(`${root}/.claude/settings.json`);
  if (state.rules.some((r) => r.source === "localSettings")) {
    files.push(`${root}/.claude/settings.local.json`);
  }
  return files;
}

/** get_hooks_listing's hooks, by event, as /hooks shows them. */
export function hooksMarkdown(body: unknown, t: Words): string {
  const listing = (body ?? {}) as { events?: unknown; hooks?: unknown };
  const hooks = Array.isArray(listing.hooks) ? (listing.hooks as Record<string, unknown>[]) : [];
  if (hooks.length === 0) return t("chat.commands.no_hooks");
  const summaries = new Map<string, string>();
  if (Array.isArray(listing.events)) {
    for (const raw of listing.events as Record<string, unknown>[]) {
      if (typeof raw?.name === "string" && typeof raw.summary === "string") {
        summaries.set(raw.name, raw.summary);
      }
    }
  }
  const byEvent = new Map<string, string[]>();
  for (const hook of hooks) {
    const event = typeof hook.event === "string" ? hook.event : "";
    const text = typeof hook.displayText === "string" ? hook.displayText : "";
    const matcher =
      typeof hook.matcher === "string" && hook.matcher ? `${code(hook.matcher)} · ` : "";
    const type = typeof hook.type === "string" ? hook.type : "";
    const source = typeof hook.sourceLabel === "string" ? hook.sourceLabel : "";
    const line = `- ${matcher}${type ? `${type} · ` : ""}${code(text)}${source ? ` · ${source}` : ""}`;
    byEvent.set(event, [...(byEvent.get(event) ?? []), line]);
  }
  return [...byEvent]
    .map(([event, lines]) => {
      const summary = summaries.get(event);
      return `**${event}**${summary ? ` — ${summary}` : ""}\n\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** Whether get_settings says the sandbox is on. */
export function sandboxOn(body: unknown): boolean {
  const effective = (body as { effective?: { sandbox?: { enabled?: unknown } } } | null)?.effective;
  return effective?.sandbox?.enabled === true;
}

/** /add-dir's folder as the program reads it: a relative one under the tab's folder. */
export function directoryArg(arg: string, cwd: string): string | null {
  const path = arg.trim().replace(/^(["'])(.*)\1$/, "$2");
  if (!path) return null;
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:[\\/]/.test(path)) return path;
  return `${cwd.replace(/[\\/]+$/, "")}/${path.replace(/^\.\//, "")}`;
}

/** get_plan's answer: the session's plan-mode plan and its file, or null when none is written. */
export function planOf(body: unknown): { content: string; path?: string } | null {
  const plan = (body ?? {}) as { exists?: unknown; content?: unknown; path?: unknown };
  if (plan.exists !== true || typeof plan.content !== "string") return null;
  return {
    content: plan.content,
    ...(typeof plan.path === "string" && plan.path ? { path: plan.path } : {}),
  };
}

/** What /branch names the copy: the name given, else the conversation's title marked, as the CLI does. */
export function branchTitle(name: string, title: string | undefined): string | undefined {
  const given = name.trim();
  if (given) return given;
  return title?.trim() ? `${title.trim()} (Branch)` : undefined;
}

/**
 * What /subtask sends: a fork of Claude with the whole conversation, whose
 * answer comes back to it (the CLI's own /subtask starts one itself).
 */
export function subtaskPrompt(task: string): string {
  return `Use the Agent tool with subagent_type "fork" for the task below, and tell me its result.\n\n${task}`;
}

export interface BackgroundSession {
  /** The short id `claude attach` and `claude stop` take. */
  id: string;
  sessionId?: string;
  name: string;
  /** idle, running, blocked, stopped… as `claude agents` says. */
  status: string;
  startedAt?: number;
}

/** The background sessions in `claude agents --json`, newest first. */
export function backgroundSessionsOf(stdout: string): BackgroundSession[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((raw): BackgroundSession[] => {
      const entry = raw as Record<string, unknown> | null;
      // The id goes on a command line (`claude attach <id>`).
      if (entry?.kind !== "background" || typeof entry.id !== "string") return [];
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(entry.id)) return [];
      const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return [
        {
          id: entry.id,
          sessionId: text(entry.sessionId),
          name: text(entry.name) ?? entry.id,
          // A stopped one has only its state.
          status:
            text(entry.state) === "stopped"
              ? "stopped"
              : (text(entry.status) ?? text(entry.state) ?? ""),
          startedAt: typeof entry.startedAt === "number" ? entry.startedAt : undefined,
        },
      ];
    })
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

/** The id `claude --bg` printed ("backgrounded · 8c55b250 (idle…)"), or null. */
export function backgroundIdOf(stdout: string): string | null {
  return /backgrounded\s*·\s*([0-9a-f]{8})\b/.exec(stdout)?.[1] ?? null;
}

/** Pages the CLI's own commands open. */
export const COMMAND_LINKS: Readonly<Record<string, string>> = {
  upgrade: "https://claude.ai/upgrade",
  "release-notes": "https://code.claude.com/docs/en/changelog",
  feedback: "https://github.com/anthropics/claude-code/issues",
  "privacy-settings": "https://claude.ai/settings/data-privacy-controls",
};

/**
 * Commands that need Claude Code's own screen, or sign it in or out: they
 * run once in a terminal, outside the conversation. The command line, and
 * the argument to quote for the terminal's shell ("" for none).
 */
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
    case "ultrareview":
    case "ultraplan":
    case "autofix-pr":
      return { command: "claude", argument: `/${name}${args ? ` ${args}` : ""}` };
    default:
      return null;
  }
}

/** The ones that change how Claude Code is signed in or what it runs: a restart picks them up. */
export const RESTART_AFTER = new Set(["login", "logout", "update"]);

export interface SkillInfo {
  name: string;
  /** Where it comes from: a plugin's name, or projectSettings, userSettings… */
  source: string;
  path?: string;
  tokens?: number;
}

/** The skills in the context's breakdown (get_context_usage). */
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

export type PluginAction = "install" | "enable" | "disable" | "update" | "uninstall";

export interface PluginInfo {
  /** name@marketplace. */
  id: string;
  version?: string;
  /** user, project, local or managed. */
  scope: string;
  enabled: boolean;
}

/** The installed plugins in `claude plugin list --json`. */
export function pluginsOf(stdout: string): PluginInfo[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): PluginInfo[] => {
    const plugin = raw as Record<string, unknown> | null;
    if (typeof plugin?.id !== "string" || !plugin.id) return [];
    return [
      {
        id: plugin.id,
        version: typeof plugin.version === "string" ? plugin.version : undefined,
        scope: typeof plugin.scope === "string" ? plugin.scope : "",
        enabled: plugin.enabled === true,
      },
    ];
  });
}

/** What a `claude plugin <action> --json` run said: its result line, else what it printed. */
export function pluginResultOf(run: { code: number; stdout: string; stderr: string }): {
  ok: boolean;
  message: string;
} {
  for (const line of run.stdout.split("\n")) {
    try {
      const result = JSON.parse(line) as { outcome?: unknown; message?: unknown };
      if (typeof result?.outcome === "string") {
        return {
          ok: result.outcome === "ok",
          message: typeof result.message === "string" ? result.message : result.outcome,
        };
      }
    } catch {
      // Not the result line.
    }
  }
  return {
    ok: run.code === 0,
    message: (run.code === 0 ? run.stdout : run.stderr || run.stdout).trim(),
  };
}
