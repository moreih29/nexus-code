/**
 * The commands while the agent view is shown. The tab and group commands
 * act on its panels; the rest of the workspace's commands would act on the
 * workspace hidden behind it (⌘W closing one of its tabs), so they do
 * nothing until the workspaces are back.
 */

import { COMMANDS, type CommandId } from "../../../shared/keybindings/commands";
import {
  type AgentLayout,
  activeKey,
  closeLeaf,
  cycleLeaf,
  cycleTab,
  removeKey,
  splitLeaf,
} from "../../services/agent-view/layout";
import { focusActiveAgent } from "../../services/agent-view/show";
import { isAgentViewShown, useAgentViewStore } from "../../state/stores/agent-view";
import { type CommandHandler, setCommandInterceptor } from "../registry";

function step(change: (layout: AgentLayout) => AgentLayout): CommandHandler {
  return () => {
    useAgentViewStore.getState().update(change);
    focusActiveAgent();
  };
}

/** ⌘W takes the front agent out of its panel, or closes a panel left empty. */
function closeFront(layout: AgentLayout): AgentLayout {
  const key = activeKey(layout);
  return key !== null ? removeKey(layout, key) : closeLeaf(layout, layout.activeLeafId);
}

const AGENT_VIEW_HANDLERS: Partial<Record<CommandId, CommandHandler>> = {
  [COMMANDS.tabClose]: step(closeFront),
  [COMMANDS.tabFocusPrev]: step((layout) => cycleTab(layout, -1)),
  [COMMANDS.tabFocusNext]: step((layout) => cycleTab(layout, 1)),
  [COMMANDS.groupSplitRight]: step((layout) => splitLeaf(layout, layout.activeLeafId, "right")),
  [COMMANDS.groupSplitDown]: step((layout) => splitLeaf(layout, layout.activeLeafId, "down")),
  [COMMANDS.groupClose]: step((layout) => closeLeaf(layout, layout.activeLeafId)),
  [COMMANDS.groupFocusLeft]: step((layout) => cycleLeaf(layout, -1)),
  [COMMANDS.groupFocusUp]: step((layout) => cycleLeaf(layout, -1)),
  [COMMANDS.groupFocusRight]: step((layout) => cycleLeaf(layout, 1)),
  [COMMANDS.groupFocusDown]: step((layout) => cycleLeaf(layout, 1)),
};

/** The commands that mean the same in both views, run as registered. */
const BOTH_VIEWS = new Set<CommandId>([
  COMMANDS.workspaceAdd,
  COMMANDS.taskNew,
  COMMANDS.sessionNextWaiting,
  COMMANDS.settingsOpen,
  COMMANDS.updatesCheck,
  COMMANDS.updatesReleaseNotes,
  COMMANDS.workbenchToggleSidebar,
  COMMANDS.workbenchToggleAgentView,
]);

/** What `id` does while the agent view is shown; undefined while it is not. */
export function routeAgentViewCommand(id: CommandId): CommandHandler | "skip" | undefined {
  if (!isAgentViewShown() || BOTH_VIEWS.has(id)) return undefined;
  return AGENT_VIEW_HANDLERS[id] ?? "skip";
}

export function registerAgentViewCommands(): Array<() => void> {
  return [setCommandInterceptor(routeAgentViewCommand)];
}
