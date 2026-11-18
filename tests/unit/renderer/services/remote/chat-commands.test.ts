/**
 * A chat's slash commands as another device sees and runs them: the agent's
 * own to send, the model and effort to set, and only those of the app's own
 * that change the conversation, whose card or toast is the answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentTabController } from "../../../../../src/renderer/services/chat/agent-tab";
import type { CodexController } from "../../../../../src/renderer/services/chat/codex-controller";
import type { ChatController } from "../../../../../src/renderer/services/chat/controller";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  type CommandCard,
  chatKey,
  emptyTabState,
  useChatStore,
} from "../../../../../src/renderer/services/chat/store";
import {
  cardText,
  chatCommandsOf,
  runRemoteCommand,
} from "../../../../../src/renderer/services/remote/chat-commands";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const ws = "ws-remote-commands";
const tabId = "t1";
const key = chatKey(ws, tabId);

function chatTab(type: "claude" | "codex" = "claude"): void {
  useTabsStore.setState((s) => ({
    byWorkspace: {
      ...s.byWorkspace,
      [ws]: { [tabId]: { id: tabId, type, title: "Chat", props: { cwd: "/p" } } },
    },
  }));
  useChatStore.getState().update(key, () => emptyTabState());
}

/** A controller with what /btw, /subtask and /sandbox use: its card in the tab's store. */
function controller(sent: string[] = []): AgentTabController {
  let seq = 0;
  const card = (next: (prev?: CommandCard) => CommandCard | undefined) =>
    useChatStore.getState().update(key, (prev) => ({ ...prev, card: next(prev.card) }));
  const fake = {
    state: { model: emptyModel() },
    showCard: (shown: Omit<CommandCard, "id">) => {
      const id = `c${++seq}`;
      card(() => ({ id, ...shown }));
      return id;
    },
    updateCard: (id: string, patch: Partial<CommandCard>) =>
      card((prev) => (prev?.id === id ? { ...prev, ...patch } : prev)),
    askAside: async (question: string) => `about ${question}`,
    addedDirectories: () => [],
    applyFlags: async () => {},
    send: async (text: string) => {
      sent.push(text);
    },
  };
  return { agent: "claude", controller: fake as unknown as ChatController };
}

afterEach(() => {
  useTabsStore.setState((s) => {
    const { [ws]: _gone, ...rest } = s.byWorkspace;
    return { byWorkspace: rest };
  });
});

describe("a chat's commands for another device", () => {
  test("a Claude tab's own go as messages, the model as a setting, and the app's that run there", () => {
    const model = {
      ...emptyModel(),
      init: {
        commands: [
          { name: "review", description: "Review a PR" },
          { name: "model", description: "Model" },
        ],
      },
    } as unknown as ReturnType<typeof emptyModel>;
    const commands = chatCommandsOf("claude", model);
    expect(commands.find((c) => c.name === "review")).toMatchObject({ runs: "send" });
    expect(commands.find((c) => c.name === "model")).toMatchObject({
      runs: "settings",
      sets: "model",
    });
    expect(commands.find((c) => c.name === "btw")).toMatchObject({
      runs: "command",
      args: "<question>",
    });
    expect(commands.find((c) => c.name === "background")).toMatchObject({ aliases: ["bg"] });
    for (const there of ["export", "memory", "permissions", "hooks", "skills", "tasks"]) {
      expect(commands.find((c) => c.name === there)).toMatchObject({ runs: "command" });
    }
    // What runs on the device that shows the chat (/copy, /diff, /help), or in a terminal here, is not offered.
    for (const shown of ["copy", "diff", "help", "logout", "exit"]) {
      expect(commands.some((c) => c.name === shown)).toBe(false);
    }
  });

  test("a Codex tab's: the model and effort as settings, the rest the app runs", () => {
    const commands = chatCommandsOf("codex", emptyModel());
    expect(commands.find((c) => c.name === "effort")).toMatchObject({ sets: "effort" });
    expect(commands.find((c) => c.name === "compact")).toMatchObject({ runs: "command" });
    expect(commands.some((c) => c.name === "logout" || c.name === "copy")).toBe(false);
    expect(commands.find((c) => c.name === "new")).toMatchObject({ aliases: ["clear"] });
    expect(commands.find((c) => c.name === "mcp")).toMatchObject({ runs: "command" });
    // What it tells of the thread there, its card's text for an answer (0.13.0).
    expect(commands.find((c) => c.name === "status")).toMatchObject({ runs: "command" });
  });
});

describe("a command's card, told to another device", () => {
  test("its text, its files as links and its lists, without buttons", () => {
    const text = cardText({
      id: "c1",
      title: "/memory",
      text: "Rules",
      files: [{ path: "/home/me/my repo/CLAUDE.md", label: "project · [x] CLAUDE.md" }],
      sections: [
        {
          title: "Tasks",
          empty: "None",
          rows: [{ id: "t", label: "build", detail: "running", actions: [] }],
        },
        { title: "Workflows", empty: "None", rows: [] },
      ],
    });
    expect(text).toBe(
      [
        "Rules",
        "- [project · \\[x\\] CLAUDE.md](</home/me/my repo/CLAUDE.md>)",
        "**Tasks**\n\n- build — running",
        "**Workflows**\n\nNone",
      ].join("\n\n"),
    );
    expect(cardText({ id: "c2", title: "/x", error: "broke", text: "t" })).toBe("broke");
    expect(cardText({ id: "c3", title: "/x" })).toBeUndefined();
  });
});

describe("running one for another device", () => {
  test("compact waits for the thread then asks the app-server to compact it", async () => {
    chatTab("codex");
    let threadId: string | undefined;
    const calls: unknown[] = [];
    const target = {
      agent: "codex" as const,
      controller: {
        model: { running: false },
        prepareSend: async () => {
          threadId = "thread-1";
        },
        currentThread: () => threadId,
        ask: async (method: string, params: unknown) => {
          calls.push({ method, params });
        },
      } as unknown as CodexController,
    };
    await runRemoteCommand(ws, tabId, target, "compact", "");
    expect(calls).toEqual([{ method: "thread/compact/start", params: { threadId: "thread-1" } }]);
  });

  test("its card's answer is what it says", async () => {
    chatTab();
    const ran = await runRemoteCommand(ws, tabId, controller(), "btw", "the build");
    expect(ran).toEqual({ message: "about the build", card: true });
  });

  test("a toast's answer is told as one, not as a card", async () => {
    chatTab();
    const ran = await runRemoteCommand(ws, tabId, controller(), "add-dir", "/p/lib");
    expect(ran.card).toBe(false);
    expect(ran.message).toContain("/p/lib");
  });

  test("what it was given goes to the agent, by its alias too", async () => {
    chatTab();
    const sent: string[] = [];
    expect(await runRemoteCommand(ws, tabId, controller(sent), "/subtask", "fix it")).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("fix it");
  });

  test("a warning it shows fails it, and one not for another device is refused", async () => {
    chatTab();
    await expect(runRemoteCommand(ws, tabId, controller(), "btw", "")).rejects.toThrow();
    await expect(runRemoteCommand(ws, tabId, controller(), "copy", "")).rejects.toThrow(
      "chat.commands",
    );
    await expect(runRemoteCommand(ws, tabId, controller(), "exit", "")).rejects.toThrow();
  });
});
