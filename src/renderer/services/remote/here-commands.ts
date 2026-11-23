import type { ChatCommand } from "../../../../packages/remote-protocol/src";
import {
  APP_COMMANDS,
  type AppCommand,
  COMMAND_LINKS,
  terminalCommandOf,
} from "../chat/app-commands";
import { CODEX_COMMANDS } from "../chat/codex/commands";

const HERE: Record<"claude" | "codex", ReadonlySet<string>> = {
  claude: new Set(["copy", "diff", "help", "exit", ...Object.keys(COMMAND_LINKS)]),
  codex: new Set(["copy", "diff", "help", "status", "exit"]),
};

const IN_TERMINAL: ReadonlySet<string> = new Set(
  APP_COMMANDS.filter((c) => terminalCommandOf(c.name, "") !== null).map((c) => c.name),
);

function namesOf(command: { name: string; aliases?: readonly string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
}

export function hereCommandsOf(
  agent: "claude" | "codex",
  listed: readonly ChatCommand[],
  terminal = false,
): AppCommand[] {
  const taken = new Set(listed.flatMap(namesOf));
  const table = agent === "claude" ? APP_COMMANDS : CODEX_COMMANDS;
  const here = (c: AppCommand) =>
    HERE[agent].has(c.name) || (terminal && agent === "claude" && IN_TERMINAL.has(c.name));
  return table.filter((c) => here(c) && !namesOf(c).some((n) => taken.has(n)));
}

export function hereCommandOf(
  agent: "claude" | "codex",
  listed: readonly ChatCommand[],
  text: string,
  terminal = false,
): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const typed = match[1].toLowerCase();
  const found = hereCommandsOf(agent, listed, terminal).find((c) => namesOf(c).includes(typed));
  return found ? { name: found.name, args: match[2]?.trim() ?? "" } : null;
}

export function hereLinkOf(name: string): string | undefined {
  return COMMAND_LINKS[name];
}

const BARE = /^[A-Za-z0-9_./:@+=-]+$/;
const QUOTABLE = /^[^"“”„$`\\!%^&|<>\r\n]*$/;

export function inTerminalLineOf(name: string, args: string): string | null {
  const run = terminalCommandOf(name, args);
  if (!run) return null;
  if (!run.argument) return run.command;
  if (BARE.test(run.argument)) return `${run.command} ${run.argument}`;
  return QUOTABLE.test(run.argument) ? `${run.command} "${run.argument}"` : null;
}
