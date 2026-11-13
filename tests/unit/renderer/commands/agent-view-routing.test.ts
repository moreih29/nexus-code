/**
 * While the agent view is shown, the workspace's commands do nothing, but
 * the ones that mean the same in both views (voice input among them) run
 * as registered.
 */
import { afterEach, describe, expect, it } from "bun:test";

(globalThis as Record<string, unknown>).window = {
  ipc: { call: () => Promise.resolve(null), listen: () => {}, off: () => {} },
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener(): void {},
    removeEventListener(): void {},
    addListener(): void {},
    removeListener(): void {},
  }),
};

const { COMMANDS } = await import("../../../../src/shared/keybindings/commands");
const { routeAgentViewCommand } = await import(
  "../../../../src/renderer/commands/domains/agent-view"
);
const { useAgentViewStore } = await import("../../../../src/renderer/state/stores/agent-view");

const initialMode = useAgentViewStore.getState().mode;
afterEach(() => useAgentViewStore.setState({ mode: initialMode }));

describe("commands in the agent view", () => {
  it("lets voice input run as registered in both views", () => {
    useAgentViewStore.setState({ mode: "agents" });
    expect(routeAgentViewCommand(COMMANDS.chatVoiceToggle)).toBeUndefined();
    expect(routeAgentViewCommand(COMMANDS.fileSave)).toBe("skip");
  });

  it("routes nothing while the workspaces are shown", () => {
    useAgentViewStore.setState({ mode: "workspace" });
    expect(routeAgentViewCommand(COMMANDS.fileSave)).toBeUndefined();
  });
});
