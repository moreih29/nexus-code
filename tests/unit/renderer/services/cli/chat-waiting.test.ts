/**
 * The nexus command's and another device's chat.withdraw and chat.hurry on
 * a Claude tab: they act only on a message the program has not begun. A
 * command written during a turn (/compact) begins after the turn's end; from
 * then on it cannot be taken back, and hurrying it would stop it.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import { ChatController } from "../../../../../src/renderer/services/chat/claude/controller";
import { applyLines } from "../../../../../src/renderer/services/chat/claude/stream-model";
import { type ChatLine, emptyModel } from "../../../../../src/renderer/services/chat/model";
import { emptyTabState, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { chatHandlers } from "../../../../../src/renderer/services/cli/chat-actions";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const workspaceId = "ws-chat-waiting";
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const out = (seq: number, message: Record<string, unknown>): ChatLine => ({
  seq,
  dir: "out",
  message,
});

/** A turn with /compact written during it; `begun`: the turn ended and the command began. */
function tabWithCompact(begun: boolean) {
  const { byWorkspace } = useTabsStore.getState();
  const tabId = useTabsStore
    .getState()
    .createTab(workspaceId, { type: "claude", props: { cwd: "/workspace" } }).id;
  const lines: ChatLine[] = [
    { seq: 1, dir: "sys", message: { event: "start", pid: 1 } },
    { seq: 2, dir: "in", message: { type: "user", uuid: "u-1", message: { content: "go" } } },
    out(3, { type: "user", isReplay: true, uuid: "u-1", message: { content: "go" } }),
    { seq: 4, dir: "in", message: { type: "user", uuid: "u-2", message: { content: "/compact" } } },
    out(5, { type: "command_lifecycle", command_uuid: "u-2", state: "queued" }),
    ...(begun
      ? [
          out(6, { type: "result", subtype: "success" }),
          out(7, { type: "command_lifecycle", command_uuid: "u-2", state: "started" }),
          out(8, { type: "system", subtype: "status", status: "compacting" }),
        ]
      : []),
  ];
  const controller = new ChatController({ workspaceId, tabId, cwd: "/workspace" });
  const model = {
    ...applyLines(emptyModel(), lines, 1000),
    version: "2.1.325",
    init: { commands: [], models: [], remoteControl: false },
  };
  useChatStore
    .getState()
    .update(controller.key, () => ({ ...emptyTabState(), phase: "ready", model }));
  const target = spyOn(agentTab, "agentTabController").mockReturnValue({
    agent: "claude",
    controller,
  });
  const read = spyOn(controller, "openToRead").mockResolvedValue(undefined);
  const withdraw = spyOn(controller, "withdraw").mockResolvedValue(true);
  const hurry = spyOn(controller, "readHeldNow").mockResolvedValue(undefined);
  restores.push(() => {
    target.mockRestore();
    read.mockRestore();
    useChatStore.getState().remove(controller.key);
    useTabsStore.setState({ byWorkspace });
  });
  const itemKey = model.items.find((item) => item.kind === "user" && item.text === "/compact")?.key;
  if (!itemKey) throw new Error("no /compact item");
  return { tabId, model, withdraw, hurry, itemKey };
}

test("a command still waiting is taken back and hurried", async () => {
  const { tabId, withdraw, hurry, itemKey } = tabWithCompact(false);
  expect(await chatHandlers["chat.withdraw"]({ workspaceId, tabId, itemKey })).toEqual({
    withdrawn: true,
  });
  expect(withdraw).toHaveBeenCalledWith("u-2");
  await chatHandlers["chat.hurry"]({ workspaceId, tabId });
  expect(hurry).toHaveBeenCalledTimes(1);
});

test("a command the program began is neither taken back nor hurried", async () => {
  const { tabId, model, withdraw, hurry, itemKey } = tabWithCompact(true);
  expect(model.running).toBe(true);
  expect(model.turn?.status).toBe("compacting");
  expect(await chatHandlers["chat.withdraw"]({ workspaceId, tabId, itemKey })).toEqual({
    withdrawn: false,
  });
  expect(withdraw).not.toHaveBeenCalled();
  await chatHandlers["chat.hurry"]({ workspaceId, tabId });
  expect(hurry).not.toHaveBeenCalled();
});
