/**
 * A Claude or Codex tab's last turns as another device's preview asks for
 * them (the chat.peek request): read without opening the tab or starting
 * its program. The real ipc client is spread under a spy that records
 * every call, so a start, a replay or a transcript read would show.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ChatPeekTail } from "../../../../../src/shared/ipc/contract";

(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ ??= "0.0.0";

const calls: [string, string, Record<string, unknown>][] = [];
let tail: (args: Record<string, unknown>) => ChatPeekTail = () => ({ offline: true });

const realIpc = await import("../../../../../src/renderer/ipc/client");
mock.module("../../../../../src/renderer/ipc/client", () => ({
  ...realIpc,
  ipcListen: () => () => {},
  ipcCallResult: (channel: string, method: string, args: Record<string, unknown>) => {
    calls.push([channel, method, args]);
    if (method === "peekTail") return Promise.resolve({ ok: true, value: tail(args) });
    return method === "replay"
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, value: undefined });
  },
}));

const { emptyModel } = await import("../../../../../src/renderer/services/chat/model");
const { chatKey, emptyTabState, useChatStore } = await import(
  "../../../../../src/renderer/services/chat/store"
);
const { chatHandlers } = await import("../../../../../src/renderer/services/cli/chat-actions");
const { useTabsStore } = await import("../../../../../src/renderer/state/stores/tabs");
const { useWorkspacesStore } = await import("../../../../../src/renderer/state/stores/workspaces");
const { relayedText } = await import("../../../../../src/shared/chat/relay");
const { WorkspaceMetaSchema } = await import("../../../../../src/shared/types/workspace");

const workspace = WorkspaceMetaSchema.parse({
  id: "5d0f8a52-2b8e-4a4f-9d3e-0c4f2f6f6a11",
  rootPath: "/workspace",
  pinned: false,
  tabs: [],
  name: "Workspace",
});
const SESSION = "0b0f8a52-2b8e-4a4f-9d3e-0c4f2f6f6a22";

let restore: () => void;
beforeEach(() => {
  calls.length = 0;
  tail = () => ({ offline: true });
  const { workspaces } = useWorkspacesStore.getState();
  const tabs = useTabsStore.getState().byWorkspace;
  const chats = useChatStore.getState().tabs;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  restore = () => {
    useTabsStore.setState({ byWorkspace: tabs });
    useWorkspacesStore.setState({ workspaces });
    useChatStore.setState({ tabs: chats });
  };
});
afterEach(() => restore());

/** A tab restored with the app: not opened since it started. */
function restoredTab(agent: "claude" | "codex", props: Record<string, unknown> = {}) {
  const session = agent === "claude" ? { sessionId: SESSION } : { threadId: SESSION };
  const tabId = useTabsStore.getState().createTab(workspace.id, {
    type: agent,
    props: { cwd: workspace.rootPath, ...session, ...props },
  } as never).id;
  return { tabId, key: chatKey(workspace.id, tabId) };
}

const peek = (tabId: string, turns?: number) =>
  chatHandlers["chat.peek"]({ workspaceId: workspace.id, tabId, ...(turns ? { turns } : {}) });

const sender = {
  kind: "tab",
  agent: "claude",
  name: "Lead",
  workspaceId: "w",
  tabId: "t",
} as const;

test("a Claude tab not opened is read from its transcript's end, and stays unopened", async () => {
  const { tabId, key } = restoredTab("claude", {
    profileId: "work",
    relayed: [{ id: "u2", from: sender, at: 1 }],
  });
  tail = () => ({
    offline: false,
    claude: {
      found: true,
      truncated: false,
      lines: [
        { type: "user", uuid: "u1", message: { role: "user", content: "Fix it" } },
        {
          type: "assistant",
          uuid: "a1",
          message: {
            id: "m1",
            role: "assistant",
            content: [
              { type: "text", text: "Fixed." },
              { type: "tool_use", id: "t1", name: "Edit", input: {} },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          message: { role: "user", content: relayedText(sender, "Now test it") },
        },
      ],
    },
  });
  expect(await peek(tabId)).toEqual({
    status: { running: false, phase: "idle" },
    turns: [
      { user: { text: "Fix it", images: 0 }, reply: "Fixed.", tools: { Edit: 1 } },
      { received: { from: "Lead", text: "Now test it" }, reply: "", tools: {} },
    ],
  });
  // One read of the history's end: nothing started, replayed or opened.
  expect(calls).toEqual([
    [
      "chat",
      "peekTail",
      {
        workspaceId: workspace.id,
        agent: "claude",
        sessionId: SESSION,
        profileId: "work",
        turns: 3,
      },
    ],
  ]);
  expect(useChatStore.getState().tabs[key]).toBeUndefined();
});

test("a Codex tab not opened is read from its rollout's end, and stays unopened", async () => {
  const { tabId, key } = restoredTab("codex");
  tail = () => ({
    offline: false,
    codex: {
      found: true,
      more: true,
      events: [
        { kind: "user", text: "Build it" },
        { kind: "tool", tool: "commandExecution" },
        { kind: "agent", text: "Built." },
      ],
    },
  });
  expect(await peek(tabId, 1)).toEqual({
    status: { running: false, phase: "idle" },
    more: true,
    turns: [{ user: { text: "Build it", images: 0 }, reply: "Built.", tools: { Bash: 1 } }],
  });
  expect(calls).toEqual([
    [
      "chat",
      "peekTail",
      { workspaceId: workspace.id, agent: "codex", sessionId: SESSION, turns: 1 },
    ],
  ]);
  expect(useChatStore.getState().tabs[key]).toBeUndefined();
});

test("a workspace whose host is not connected is offline; a chat that never ran is missing", async () => {
  const { tabId } = restoredTab("claude");
  expect(await peek(tabId)).toEqual({
    status: { running: false, phase: "idle" },
    turns: [],
    unavailable: "offline",
  });
  tail = () => ({ offline: false, claude: { found: false, truncated: false, lines: [] } });
  expect((await peek(tabId)).unavailable).toBe("missing");
  // An agent too old to read a rollout's end.
  tail = () => ({ offline: false });
  expect((await peek(restoredTab("codex").tabId)).unavailable).toBe("missing");

  // No session yet: nothing is asked of the agent.
  calls.length = 0;
  const fresh = useTabsStore
    .getState()
    .createTab(workspace.id, { type: "claude", props: { cwd: workspace.rootPath } }).id;
  expect((await peek(fresh)).unavailable).toBe("missing");
  expect(calls).toEqual([]);
});

test("an open tab is read from the conversation it holds, with nothing asked of main", async () => {
  const { tabId, key } = restoredTab("claude");
  useChatStore.setState((state) => ({
    tabs: {
      ...state.tabs,
      [key]: {
        ...emptyTabState(),
        phase: "ready",
        model: {
          ...emptyModel(),
          running: true,
          items: [
            { kind: "user", key: "u1", text: "Go", images: [], state: "taken" },
            {
              kind: "assistant",
              key: "a1",
              messageId: "m1",
              blocks: [{ type: "text", text: "Going." }],
            },
          ],
          permissions: [{ requestId: "r1", toolName: "Bash", input: {}, suggestions: [] }],
        },
      },
    },
  }));
  expect(await peek(tabId)).toEqual({
    status: { running: true, phase: "ready" },
    turns: [{ user: { text: "Go", images: 0 }, reply: "Going.", tools: {} }],
    waiting: { kind: "permission", tool: "Bash" },
  });
  expect(calls).toEqual([]);
});

test("a tab opening, its conversation not in yet, tells its history's turns as it stands", async () => {
  const { tabId, key } = restoredTab("codex");
  useChatStore.setState((state) => ({
    tabs: { ...state.tabs, [key]: { ...emptyTabState(), phase: "starting" } },
  }));
  tail = () => ({
    offline: false,
    codex: {
      found: true,
      events: [
        { kind: "user", text: "Earlier" },
        { kind: "agent", text: "Yes." },
      ],
    },
  });
  expect(await peek(tabId)).toEqual({
    status: { running: false, phase: "starting" },
    turns: [{ user: { text: "Earlier", images: 0 }, reply: "Yes.", tools: {} }],
  });
  // With its host not connected, it is still the open tab's answer: no turns, not unavailable.
  tail = () => ({ offline: true });
  expect(await peek(tabId)).toEqual({ status: { running: false, phase: "starting" }, turns: [] });
});

test("a tab that is not a chat, or not there, is refused", async () => {
  const terminal = useTabsStore
    .getState()
    .createTab(workspace.id, { type: "terminal", props: { cwd: workspace.rootPath } } as never).id;
  await expect(peek(terminal)).rejects.toThrow("not a Claude or Codex tab");
  await expect(peek("nope")).rejects.toThrow("not a Claude or Codex tab");
});
