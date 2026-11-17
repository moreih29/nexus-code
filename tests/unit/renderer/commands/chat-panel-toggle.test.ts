/**
 * The chat side panel command toggles the panel of the chat in front: the
 * active group's active tab in the workspaces, the active panel's agent in
 * the agent view (a chat here by its tab, another computer's by its key).
 * With no chat with a panel in front, it does nothing and the key is not the
 * app's.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

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

const { chatPanelActive, registerChatPanelCommands } = await import(
  "../../../../src/renderer/commands/domains/chat-panel"
);
const { __resetCommandsForTests, executeCommand } = await import(
  "../../../../src/renderer/commands/registry"
);
const { remoteSessionKey } = await import("../../../../src/renderer/services/agent-view/layout");
const { registerPanelToggle } = await import("../../../../src/renderer/services/chat/panel-toggle");
const { useActiveStore } = await import("../../../../src/renderer/state/stores/active");
const { useAgentViewStore } = await import("../../../../src/renderer/state/stores/agent-view");
const { useLayoutStore } = await import("../../../../src/renderer/state/stores/layout");
const { COMMANDS } = await import("../../../../src/shared/keybindings/commands");

const toggle = () => executeCommand(COMMANDS.chatTogglePanel);
const initialMode = useAgentViewStore.getState().mode;

/** The workspace `ws` showing `tabId` in its only group. */
function front(ws: string, tabId: string | null): void {
  useActiveStore.setState({ activeWorkspaceId: ws });
  useLayoutStore.setState({
    byWorkspace: {
      [ws]: {
        root: { kind: "leaf", id: "g", tabIds: tabId ? [tabId] : [], activeTabId: tabId },
        activeGroupId: "g",
      },
    },
  });
}

/** The agent view showing `key` in its active panel. */
function agentViewFront(key: string): void {
  useAgentViewStore.setState({
    mode: "agents",
    root: { kind: "leaf", id: "p", tabIds: [key], activeTabId: key },
    activeLeafId: "p",
  });
}

let offs: Array<() => void> = [];
const counts = new Map<string, number>();
function chat(key: string): void {
  counts.set(key, 0);
  offs.push(registerPanelToggle(key, () => counts.set(key, (counts.get(key) ?? 0) + 1)));
}

beforeEach(() => {
  __resetCommandsForTests();
  offs = registerChatPanelCommands();
  counts.clear();
  useAgentViewStore.setState({ mode: "workspace" });
});

afterEach(() => {
  for (const off of offs) off();
  useLayoutStore.setState({ byWorkspace: {} });
  useAgentViewStore.setState({ mode: initialMode });
});

describe("the chat side panel command", () => {
  it("toggles the panel of the active tab", () => {
    chat("claude-1");
    chat("claude-2");
    front("ws-a", "claude-1");
    expect(chatPanelActive()).toBe(true);
    toggle();
    toggle();
    expect(counts.get("claude-1")).toBe(2);
    expect(counts.get("claude-2")).toBe(0);
  });

  it("does nothing with a tab without a panel in front", () => {
    chat("claude-1");
    front("ws-a", "codex-1");
    expect(chatPanelActive()).toBe(false);
    toggle();
    expect(counts.get("claude-1")).toBe(0);
  });

  it("does nothing with no tab or no workspace", () => {
    chat("claude-1");
    front("ws-a", null);
    expect(chatPanelActive()).toBe(false);
    useActiveStore.setState({ activeWorkspaceId: null });
    expect(chatPanelActive()).toBe(false);
    toggle();
    expect(counts.get("claude-1")).toBe(0);
  });

  it("stops once the chat's view is gone", () => {
    const off = registerPanelToggle("claude-9", () => counts.set("claude-9", 1));
    front("ws-a", "claude-9");
    off();
    expect(chatPanelActive()).toBe(false);
    toggle();
    expect(counts.get("claude-9")).toBeUndefined();
  });

  it("toggles the agent view's front agent, a chat here by its tab", () => {
    chat("claude-1");
    chat("claude-2");
    front("ws-a", "claude-2");
    agentViewFront("ws-a:claude-1");
    expect(chatPanelActive()).toBe(true);
    toggle();
    expect(counts.get("claude-1")).toBe(1);
    expect(counts.get("claude-2")).toBe(0);
  });

  it("toggles another computer's session in the agent view by its key", () => {
    const key = remoteSessionKey({ deviceId: "d", workspaceId: "w", tabId: "t" });
    chat(key);
    agentViewFront(key);
    expect(chatPanelActive()).toBe(true);
    toggle();
    expect(counts.get(key)).toBe(1);
  });
});
