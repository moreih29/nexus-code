import { afterEach, beforeEach, expect, mock, test } from "bun:test";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (_channel: string, method: string) =>
    method === "replay" ? new Promise(() => {}) : Promise.resolve({ ok: true, value: undefined }),
}));

const { agentTabController } = await import("../../../../../src/renderer/services/chat/agent-tab");
const { chatKey, useChatStore } = await import("../../../../../src/renderer/services/chat/store");
const { sendFirstMessage } = await import(
  "../../../../../src/renderer/services/chat/transport/submission"
);
const { peekChatInfo } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { WorkspaceMetaSchema } = await import("../../../../../src/shared/types/workspace");

const workspace = WorkspaceMetaSchema.parse({
  id: "5d0f8a52-2b8e-4a4f-9d3e-0c4f2f6f6a11",
  rootPath: "/workspace",
  pinned: false,
  tabs: [],
  name: "Workspace",
});

let restore: () => void;
const live: { dispose(): void }[] = [];
beforeEach(() => {
  const { workspaces } = useWorkspacesStore.getState();
  const tabs = useTabsStore.getState().byWorkspace;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  restore = () => {
    useTabsStore.setState({ byWorkspace: tabs });
    useWorkspacesStore.setState({ workspaces });
  };
});
afterEach(() => {
  for (const controller of live.splice(0)) controller.dispose();
  restore();
});

function restoredTab(agent: "claude" | "codex") {
  const tabId = useTabsStore
    .getState()
    .createTab(workspace.id, { type: agent, props: { cwd: workspace.rootPath } }).id;
  const target = agentTabController(workspace.id, tabId);
  if (!target) throw new Error("no controller");
  live.push(target.controller);
  return { tabId, target, key: chatKey(workspace.id, tabId) };
}

test.each([
  "claude",
  "codex",
] as const)("a restored %s tab brought to the front reads idle while its log comes in", (agent) => {
  const { tabId, target, key } = restoredTab(agent);
  const state = () => peekChatInfo(workspace.id, tabId).state;
  expect(state()).toBe("idle");

  void target.controller.open();
  expect(target.controller.isOpening).toBe(true);
  expect(useChatStore.getState().tabs[key]?.phase).toBe("starting");
  expect(peekChatInfo(workspace.id, tabId)).toEqual({ agent, state: "idle" });

  void sendFirstMessage(workspace.id, tabId, target, "Go on").catch(() => {});
  expect(state()).toBe("working");
});

test("a tab opened to show it reads as it stands once its log is in", () => {
  const { tabId, target, key } = restoredTab("claude");
  void target.controller.open();
  expect(peekChatInfo(workspace.id, tabId).state).toBe("idle");
  useChatStore.getState().update(key, (prev) => ({
    ...prev,
    phase: "ready",
    model: { ...prev.model, running: true },
  }));
  expect(target.controller.isOpening).toBe(true);
  expect(peekChatInfo(workspace.id, tabId).state).toBe("working");
});
