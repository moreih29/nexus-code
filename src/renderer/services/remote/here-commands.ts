/**
 * The app's commands another computer's chat runs on this one, as a tab of
 * its own runs them there: what they need is what this app shows of the
 * chat (/copy, /help), a part of its side panel (/diff), or a page to open
 * (/feedback and the like). A command the chat lists under the same name is
 * the chat's, as a CLI's own is the CLI's in a tab here.
 */

import type { ChatCommand } from "../../../../packages/remote-protocol/src";
import { APP_COMMANDS, type AppCommand, COMMAND_LINKS } from "../chat/app-commands";
import { CODEX_COMMANDS } from "../chat/codex-commands";

const HERE: Record<"claude" | "codex", ReadonlySet<string>> = {
  claude: new Set(["copy", "diff", "help", ...Object.keys(COMMAND_LINKS)]),
  codex: new Set(["copy", "diff", "help"]),
};

/** The names a command is typed by, in lower case. */
function namesOf(command: { name: string; aliases?: readonly string[] }): string[] {
  return [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
}

/** The commands this app runs here for the chat, in its tab's order: none the chat lists itself. */
export function hereCommandsOf(
  agent: "claude" | "codex",
  listed: readonly ChatCommand[],
): AppCommand[] {
  const taken = new Set(listed.flatMap(namesOf));
  const table = agent === "claude" ? APP_COMMANDS : CODEX_COMMANDS;
  return table.filter((c) => HERE[agent].has(c.name) && !namesOf(c).some((n) => taken.has(n)));
}

/** The command of this app's a typed `/name args` runs here; null for one the chat runs. */
export function hereCommandOf(
  agent: "claude" | "codex",
  listed: readonly ChatCommand[],
  text: string,
): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return null;
  const typed = match[1].toLowerCase();
  const found = hereCommandsOf(agent, listed).find((c) => namesOf(c).includes(typed));
  return found ? { name: found.name, args: match[2]?.trim() ?? "" } : null;
}

/** The page a command opens, when it opens one. */
export function hereLinkOf(name: string): string | undefined {
  return COMMAND_LINKS[name];
}
