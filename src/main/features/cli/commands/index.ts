/** Every nexus command, in the order help lists them. */
import type { CliCommand } from "../registry";
import { browserCommands } from "./browser";
import { editorCommands } from "./editor";
import { notifyCommands } from "./notify";
import { terminalCommands } from "./terminal";
import { workspaceCommands } from "./workspace";

export const CLI_COMMANDS: readonly CliCommand[] = [
  ...workspaceCommands,
  ...terminalCommands,
  ...editorCommands,
  ...browserCommands,
  ...notifyCommands,
];
