/** Every nexus command, in the order help lists them. */
import type { CliCommand } from "../registry";
import { agentCommands } from "./agent";
import { agentContextCommands } from "./agent-context";
import { browserCommands } from "./browser";
import { browserControlCommands } from "./browser-control";
import { browserNetworkCommands } from "./browser-network";
import { chatCommands } from "./chat";
import { editorCommands } from "./editor";
import { layoutCommands, tabArrangeCommands } from "./layout";
import { notifyCommands } from "./notify";
import { panelCommands } from "./panel";
import { portCommands } from "./port";
import { settingsCommands } from "./settings";
import { terminalCommands } from "./terminal";
import { workspaceCommands } from "./workspace";

export const CLI_COMMANDS: readonly CliCommand[] = [
  ...workspaceCommands,
  ...terminalCommands,
  ...chatCommands,
  ...tabArrangeCommands,
  ...layoutCommands,
  ...panelCommands,
  ...settingsCommands,
  ...editorCommands,
  ...browserCommands,
  ...browserControlCommands,
  ...browserNetworkCommands,
  ...portCommands,
  ...notifyCommands,
  ...agentCommands,
  ...agentContextCommands,
];
