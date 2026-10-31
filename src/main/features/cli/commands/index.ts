/** Every nexus command, in the order help lists them. */
import type { CliCommand } from "../registry";
import { notifyCommands } from "./notify";
import { terminalCommands } from "./terminal";
import { workspaceCommands } from "./workspace";

export const CLI_COMMANDS: readonly CliCommand[] = [
  ...workspaceCommands,
  ...terminalCommands,
  ...notifyCommands,
];
