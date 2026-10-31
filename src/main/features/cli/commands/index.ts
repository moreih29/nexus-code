/** Every nexus command, in the order help lists them. */
import type { CliCommand } from "../registry";
import { agentContextCommands } from "./agent-context";
import { browserCommands } from "./browser";
import { browserControlCommands } from "./browser-control";
import { editorCommands } from "./editor";
import { layoutCommands, tabArrangeCommands } from "./layout";
import { notifyCommands } from "./notify";
import { panelCommands } from "./panel";
import { terminalCommands } from "./terminal";
import { workspaceCommands } from "./workspace";

export const CLI_COMMANDS: readonly CliCommand[] = [
  ...workspaceCommands,
  ...terminalCommands,
  ...tabArrangeCommands,
  ...layoutCommands,
  ...panelCommands,
  ...editorCommands,
  ...browserCommands,
  ...browserControlCommands,
  ...notifyCommands,
  ...agentContextCommands,
];
