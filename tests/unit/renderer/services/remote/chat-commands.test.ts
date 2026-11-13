/**
 * A chat's slash commands as another device sees and runs them: the agent's
 * own to send, the model and effort to set, and only those of the app's own
 * that change the conversation, whose card or toast is the answer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentTabController } from "../../../../../src/renderer/services/chat/agent-tab";
import type { ChatController } from "../../../../../src/renderer/services/chat/controller";
import { emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  type CommandCard,
  chatKey,
  emptyTabState,
  useChatStore,
} from "../../../../../src/renderer/services/chat/store";
import {
  chatCommandsOf,
  runRemoteCommand,
} from "../../../../../src/renderer/services/remote/chat-commands";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const ws = "ws-remote-commands";
const tabId = "t1";
const key = chatKey(ws, tabId);

function claudeTab(): void {
  useTabsStore.setState((s) => ({
    byWorkspace: {
      ...s.byWorkspace,
      [ws]: { [tabId]: { id: tabId, type: "claude", title: "Chat", props: { cwd: "/p" } } },
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
  test("a Claude tab's own go as messages, the model as a setting, and only the app's that change the chat", () => {
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
    for (const shown of ["copy", "export", "diff", "memory", "logout", "exit"]) {
      expect(commands.some((c) => c.name === shown)).toBe(false);
    }
  });

  test("a Codex tab's: the model and effort as settings, the rest the app runs", () => {
    const commands = chatCommandsOf("codex", emptyModel());
    expect(commands.find((c) => c.name === "effort")).toMatchObject({ sets: "effort" });
    expect(commands.find((c) => c.name === "compact")).toMatchObject({ runs: "command" });
    expect(commands.some((c) => c.name === "logout" || c.name === "copy")).toBe(false);
  });
});

describe("running one for another device", () => {
  test("its card's answer is what it says", async () => {
    claudeTab();
    const ran = await runRemoteCommand(ws, tabId, controller(), "btw", "the build");
    expect(ran).toEqual({ message: "about the build" });
  });

  test("what it was given goes to the agent, by its alias too", async () => {
    claudeTab();
    const sent: string[] = [];
    expect(await runRemoteCommand(ws, tabId, controller(sent), "/subtask", "fix it")).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("fix it");
  });

  test("a warning it shows fails it, and one not for another device is refused", async () => {
    claudeTab();
    await expect(runRemoteCommand(ws, tabId, controller(), "btw", "")).rejects.toThrow();
    await expect(runRemoteCommand(ws, tabId, controller(), "copy", "")).rejects.toThrow(
      "chat.commands",
    );
    await expect(runRemoteCommand(ws, tabId, controller(), "exit", "")).rejects.toThrow();
  });
});
