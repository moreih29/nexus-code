import { afterEach, describe, expect, test } from "bun:test";
import { ChatPanelSchema } from "../../../../../packages/remote-protocol/src";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  chatKey,
  emptyTabState,
  useChatStore,
} from "../../../../../src/renderer/services/chat/store";
import {
  twinOf,
  useClaudeSessionsStore,
} from "../../../../../src/renderer/services/chat/terminal-twin";
import { chatPanelOf } from "../../../../../src/renderer/services/remote/chat-panel";
import {
  type ChatChange,
  startChatWatch,
  stopChatWatch,
  tabSource,
  terminalTwinOf,
} from "../../../../../src/renderer/services/remote/chat-watch";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const ws = "ws-chat-twin";
const chat = "chat";
const session = "11111111-2222-4333-8444-555555555555";

function tabs(more: Record<string, "terminal" | "claude" | "codex">): void {
  const byId: Record<string, unknown> = {
    [chat]: { id: chat, type: "claude", title: "Chat", props: { cwd: "/p" } },
  };
  for (const [id, type] of Object.entries(more)) {
    byId[id] = { id, type, title: id, props: { cwd: "/p" } };
  }
  useTabsStore.setState((s) => ({
    byWorkspace: { ...s.byWorkspace, [ws]: byId as never },
  }));
  useChatStore.getState().update(chatKey(ws, chat), () => ({
    ...emptyTabState(),
    model: { ...emptyModel(), sessionId: session },
  }));
}

function sessions(list: { tabId: string; sessionId: string }[]): void {
  useClaudeSessionsStore.setState((s) => ({ byWorkspace: { ...s.byWorkspace, [ws]: list } }));
}

afterEach(() => {
  useTabsStore.setState((s) => {
    const { [ws]: _gone, ...rest } = s.byWorkspace;
    return { byWorkspace: rest };
  });
  useClaudeSessionsStore.setState((s) => {
    const { [ws]: _gone, ...rest } = s.byWorkspace;
    return { byWorkspace: rest };
  });
});

describe("a chat's terminal twin", () => {
  test("is another tab running the same Claude session, never the chat itself", () => {
    const list = [
      { tabId: chat, sessionId: session },
      { tabId: "term", sessionId: session },
      { tabId: "other", sessionId: "another" },
    ];
    expect(twinOf(list, chat, session)).toBe("term");
    expect(twinOf(list.slice(0, 1), chat, session)).toBeNull();
    expect(twinOf([], chat, session)).toBeNull();
  });

  test("another device is told of a terminal tab only", () => {
    tabs({ term: "terminal", other: "claude" });
    sessions([{ tabId: "other", sessionId: session }]);
    expect(terminalTwinOf(ws, chat, session)).toBeNull();
    sessions([
      { tabId: "term", sessionId: session },
      { tabId: chat, sessionId: session },
    ]);
    expect(terminalTwinOf(ws, chat, session)).toBe("term");
    expect(terminalTwinOf(ws, chat, undefined)).toBeNull();
  });

  test("goes into the chat's panel as its tab's id", () => {
    tabs({ term: "terminal" });
    sessions([{ tabId: "term", sessionId: session }]);
    const source = tabSource(ws, chat, "claude");
    expect(source?.twin).toBe("term");
    const panel = chatPanelOf(source as NonNullable<typeof source>);
    expect(panel.twin).toEqual({ tabId: "term" });
    expect(ChatPanelSchema.safeParse(panel).success).toBe(true);
    sessions([]);
    const alone = tabSource(ws, chat, "claude");
    expect(chatPanelOf(alone as NonNullable<typeof alone>)).not.toHaveProperty("twin");
  });

  test("a watch sends the panel again when a terminal starts or stops the session", async () => {
    tabs({ term: "terminal" });
    sessions([]);
    const changes: ChatChange[] = [];
    let followed = 0;
    let unfollowed = 0;
    const page = startChatWatch(
      "twin-watch",
      () => tabSource(ws, chat, "claude"),
      10,
      (change) => changes.push(change),
      () => {},
      {
        follow: () => {
          followed += 1;
          return () => {
            unfollowed += 1;
          };
        },
      },
    );
    expect(page.panel).not.toHaveProperty("twin");
    expect(followed).toBe(1);
    sessions([{ tabId: "term", sessionId: session }]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes.at(-1)?.panel?.twin).toEqual({ tabId: "term" });
    sessions([]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changes.at(-1)?.panel).toBeDefined();
    expect(changes.at(-1)?.panel).not.toHaveProperty("twin");
    stopChatWatch("twin-watch");
    expect(unfollowed).toBe(1);
  });
});
