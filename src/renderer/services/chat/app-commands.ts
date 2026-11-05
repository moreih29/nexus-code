// Commands the Claude tab runs itself: Claude Code's built-ins that its
// headless mode lacks (/copy, /btw, /memory…), done in the GUI. A command
// the CLI lists under the same name is the CLI's, so a Claude Code that
// gains one runs its own. Pure, for the tab and its tests.

import type { AssistantItem, ChatItem, CommandInfo, ToolCall } from "./model";

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
  { name: "memory" },
  { name: "help" },
  { name: "exit", aliases: ["quit"] },
];

function namesOf(command: { name: string; aliases?: string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
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
    if (item.kind === "user") close();
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
    if (item.kind === "notice") continue;
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
        lines.push(
          summary ? `- **${tool.name}** \`${summary.replace(/`/g, "'")}\`` : `- **${tool.name}**`,
        );
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
