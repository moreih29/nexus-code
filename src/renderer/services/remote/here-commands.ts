/**
 * The app's commands another computer's chat runs on this one, as a tab of
 * its own runs them there: what they need is what this app shows of the
 * chat (/copy, /help), a part of its side panel (/diff), or a page to open
 * (/feedback and the like). A command the chat lists under the same name is
 * the chat's, as a CLI's own is the CLI's in a tab here: a Codex chat's
 * /status is its computer's from 0.13.0, and from what this app shows of
 * it before. Claude's commands that run once in a terminal (/login,
 * /update…) run in a terminal of that computer, shown here, where it lets
 * this one type into its terminals.
 */

import type { ChatCommand } from "../../../../packages/remote-protocol/src";
import {
  APP_COMMANDS,
  type AppCommand,
  COMMAND_LINKS,
  terminalCommandOf,
} from "../chat/app-commands";
import { CODEX_COMMANDS } from "../chat/codex-commands";

const HERE: Record<"claude" | "codex", ReadonlySet<string>> = {
  claude: new Set(["copy", "diff", "help", "exit", ...Object.keys(COMMAND_LINKS)]),
  codex: new Set(["copy", "diff", "help", "status", "exit"]),
};

/** Claude's commands that run once in a terminal, outside the conversation. */
const IN_TERMINAL: ReadonlySet<string> = new Set(
  APP_COMMANDS.filter((c) => terminalCommandOf(c.name, "") !== null).map((c) => c.name),
);

/** The names a command is typed by, in lower case. */
function namesOf(command: { name: string; aliases?: readonly string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
}

/**
 * The commands this app runs here for the chat, in its tab's order: none
 * the chat lists itself; those that run in a terminal only where that
 * computer's `terminal` can be typed into.
 */
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

/** The command of this app's a typed `/name args` runs here; null for one the chat runs. */
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

/** The page a command opens, when it opens one. */
export function hereLinkOf(name: string): string | undefined {
  return COMMAND_LINKS[name];
}

/** A word any shell there takes as it is. */
const BARE = /^[A-Za-z0-9_./:@+=-]+$/;
/**
 * Text a shell there takes as one word in double quotes: none of what any
 * of them expands, and none of the typographic double quotes, which
 * PowerShell takes as `"`.
 */
const QUOTABLE = /^[^"“”„$`\\!%^&|<>\r\n]*$/;

/**
 * The line a command that runs in a terminal types into that computer's,
 * as a terminal here runs it: its argument as one word, whatever that
 * computer's shell (POSIX, PowerShell or cmd); null when it has what one
 * of them would expand, or for a command that does not run in a terminal.
 */
export function inTerminalLineOf(name: string, args: string): string | null {
  const run = terminalCommandOf(name, args);
  if (!run) return null;
  if (!run.argument) return run.command;
  if (BARE.test(run.argument)) return `${run.command} ${run.argument}`;
  return QUOTABLE.test(run.argument) ? `${run.command} "${run.argument}"` : null;
}
