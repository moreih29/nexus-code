import type { CliCommand } from "../registry";
import { agentCommands } from "./agent";
import { agentContextCommands } from "./agent-context";
import { browserCommands } from "./browser";
import { browserControlCommands } from "./browser-control";
import { browserNetworkCommands } from "./browser-network";
import { chatCommands } from "./chat";
import { chatControlCommands } from "./chat-control";
import { deviceCommands } from "./device";
import { editorCommands } from "./editor";
import { eventCommands } from "./events";
import { fileCommands } from "./file";
import { layoutCommands, tabArrangeCommands } from "./layout";
import { noteCommands } from "./note";
import { notifyCommands } from "./notify";
import { panelCommands } from "./panel";
import { portCommands } from "./port";
import { settingsCommands } from "./settings";
import { terminalCommands } from "./terminal";
import { viewCommands } from "./view";
import { workspaceCommands } from "./workspace";

export const CLI_COMMANDS: readonly CliCommand[] = [
  ...workspaceCommands,
  ...terminalCommands,
  ...chatCommands,
  ...chatControlCommands,
  ...eventCommands,
  ...deviceCommands,
  ...fileCommands,
  ...tabArrangeCommands,
  ...layoutCommands,
  ...viewCommands,
  ...panelCommands,
  ...settingsCommands,
  ...editorCommands,
  ...browserCommands,
  ...browserControlCommands,
  ...browserNetworkCommands,
  ...portCommands,
  ...notifyCommands,
  ...noteCommands,
  ...agentCommands,
  ...agentContextCommands,
];
