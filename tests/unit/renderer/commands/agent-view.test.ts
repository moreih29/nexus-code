/**
 * While the agent view is shown, the tab and group commands act on its
 * panels, and the workspace's other commands do nothing: ⌘W takes the front
 * agent out of its panel instead of closing a tab of the workspace hidden
 * behind it. With the workspaces shown, every command runs as registered.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { routeAgentViewCommand } from "../../../../src/renderer/commands/domains/agent-view";
import {
  __resetCommandsForTests,
  executeCommand,
  registerCommand,
  setCommandInterceptor,
} from "../../../../src/renderer/commands/registry";
import { heldKeys } from "../../../../src/renderer/services/agent-view/layout";
import {
  __resetAgentViewForTests,
  useAgentViewStore,
} from "../../../../src/renderer/state/stores/agent-view";
import { COMMANDS } from "../../../../src/shared/keybindings/commands";

const A = "ws-a:t1";
const B = "ws-b:t2";

function showAgentView(): void {
  useAgentViewStore.setState({
    mode: "agents",
    root: { kind: "leaf", id: "p1", tabIds: [A, B], activeTabId: B },
    activeLeafId: "p1",
  });
}

describe("commands in the agent view", () => {
  const ran: string[] = [];

  beforeEach(() => {
    ran.length = 0;
    __resetCommandsForTests();
    __resetAgentViewForTests();
    for (const id of [COMMANDS.tabClose, COMMANDS.fileSave, COMMANDS.settingsOpen]) {
      registerCommand(id, () => {
        ran.push(id);
      });
    }
    setCommandInterceptor(routeAgentViewCommand);
  });

  afterEach(() => {
    __resetCommandsForTests();
    __resetAgentViewForTests();
  });

  it("runs every command as registered while the workspaces are shown", () => {
    executeCommand(COMMANDS.tabClose);
    executeCommand(COMMANDS.fileSave);
    expect(ran).toEqual([COMMANDS.tabClose, COMMANDS.fileSave]);
  });

  it("takes the front agent out of its panel on Close Tab, closing no tab", () => {
    showAgentView();
    executeCommand(COMMANDS.tabClose);
    expect(ran).toEqual([]);
    expect(heldKeys(useAgentViewStore.getState().root)).toEqual([A]);
  });

  it("splits the active panel, the front agent moving into the new one", () => {
    showAgentView();
    executeCommand(COMMANDS.groupSplitRight);
    const { root, activeLeafId } = useAgentViewStore.getState();
    expect(root.kind).toBe("split");
    expect(activeLeafId).not.toBe("p1");
    expect(heldKeys(root)).toEqual([A, B]);
  });

  it("steps through the active panel's agents", () => {
    showAgentView();
    executeCommand(COMMANDS.tabFocusNext);
    const { root } = useAgentViewStore.getState();
    expect(root.kind === "leaf" && root.activeTabId).toBe(A);
  });

  it("does nothing for a command of the workspace hidden behind the view", () => {
    showAgentView();
    executeCommand(COMMANDS.fileSave);
    expect(ran).toEqual([]);
  });

  it("runs the commands that mean the same in both views", () => {
    showAgentView();
    executeCommand(COMMANDS.settingsOpen);
    expect(ran).toEqual([COMMANDS.settingsOpen]);
  });
});
