/**
 * The agents panel command shows the files panel on the active workspace's
 * agent list; run again there, it hides the panel.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";

const g = globalThis as Record<string, unknown>;
const hadWindow = g.window !== undefined;
const ipcBefore = hadWindow ? (g.window as Record<string, unknown>).ipc : undefined;
if (!hadWindow) g.window = {};
(g.window as Record<string, unknown>).ipc = {
  call: () => Promise.resolve(null),
  listen: () => {},
  off: () => {},
};
afterAll(() => {
  if (!hadWindow) g.window = undefined;
  else (g.window as Record<string, unknown>).ipc = ipcBefore;
});

const { registerWorkbenchCommands } = await import(
  "../../../../src/renderer/commands/domains/workbench"
);
const { __resetCommandsForTests, executeCommand } = await import(
  "../../../../src/renderer/commands/registry"
);
const { useActiveStore } = await import("../../../../src/renderer/state/stores/active");
const { FILES_PANEL_MODE_DEFAULT, useUIStore } = await import(
  "../../../../src/renderer/state/stores/ui"
);
const { COMMANDS } = await import("../../../../src/shared/keybindings/commands");

const modeOf = (workspaceId: string) =>
  useUIStore.getState().filesPanelModes.get(workspaceId) ?? FILES_PANEL_MODE_DEFAULT;
const toggle = () => executeCommand(COMMANDS.workbenchToggleAgentsPanel);

beforeEach(() => {
  __resetCommandsForTests();
  registerWorkbenchCommands();
  useUIStore.getState().hydrate({});
  useActiveStore.setState({ activeWorkspaceId: "ws-a" });
});

describe("the agents panel command", () => {
  it("shows a hidden files panel on the agent list", () => {
    useUIStore.getState().setPanelHidden("files", true);
    toggle();
    expect(useUIStore.getState().filesPanelHidden).toBe(false);
    expect(modeOf("ws-a")).toBe("agents");
  });

  it("turns a shown files panel to the agent list", () => {
    useUIStore.getState().setFilesPanelMode("ws-a", "git");
    useUIStore.getState().setPanelHidden("files", false);
    toggle();
    expect(useUIStore.getState().filesPanelHidden).toBe(false);
    expect(modeOf("ws-a")).toBe("agents");
  });

  it("hides the panel when it already shows the agent list", () => {
    useUIStore.getState().setFilesPanelMode("ws-a", "agents");
    useUIStore.getState().setPanelHidden("files", false);
    toggle();
    expect(useUIStore.getState().filesPanelHidden).toBe(true);
    expect(modeOf("ws-a")).toBe("agents");
    toggle();
    expect(useUIStore.getState().filesPanelHidden).toBe(false);
  });

  it("changes only the active workspace's view", () => {
    useUIStore.getState().setFilesPanelMode("ws-b", "tree");
    toggle();
    expect(modeOf("ws-b")).toBe("tree");
  });

  it("does nothing with no workspace", () => {
    useActiveStore.setState({ activeWorkspaceId: null });
    useUIStore.getState().setPanelHidden("files", true);
    toggle();
    expect(useUIStore.getState().filesPanelHidden).toBe(true);
  });
});
