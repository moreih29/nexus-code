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
import { activeLocalPanelTab, focusActiveAgent } from "../../services/agent-view/show";
import { isAgentViewShown, useAgentViewStore } from "../../state/stores/agent-view";
import { type CommandHandler, setCommandInterceptor } from "../registry";

function step(change: (layout: AgentLayout) => AgentLayout): CommandHandler {
  return () => {
    useAgentViewStore.getState().update(change);
    focusActiveAgent();
  };
}

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

const BOTH_VIEWS = new Set<CommandId>([
  COMMANDS.workspaceAdd,
  COMMANDS.taskNew,
  COMMANDS.sessionNextWaiting,
  COMMANDS.settingsOpen,
  COMMANDS.updatesCheck,
  COMMANDS.updatesReleaseNotes,
  COMMANDS.workbenchToggleSidebar,
  COMMANDS.workbenchToggleAgentView,
  COMMANDS.chatVoiceToggle,
  COMMANDS.chatTogglePanel,
]);

export function routeAgentViewCommand(id: CommandId): CommandHandler | "skip" | undefined {
  if (!isAgentViewShown() || BOTH_VIEWS.has(id)) return undefined;
  if (id === COMMANDS.fileSave && activeLocalPanelTab()?.tab.type === "editor") return undefined;
  return AGENT_VIEW_HANDLERS[id] ?? "skip";
}

export function registerAgentViewCommands(): Array<() => void> {
  return [setCommandInterceptor(routeAgentViewCommand)];
}
