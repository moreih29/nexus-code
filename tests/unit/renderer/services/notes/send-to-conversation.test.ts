import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { agentTabController } from "../../../../../src/renderer/services/chat/agent-tab";
import { chatKey, useChatStore } from "../../../../../src/renderer/services/chat/store";
import { sendToConversation } from "../../../../../src/renderer/services/notes/send-to-conversation";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

test("a note sent to a running Claude tab goes to its composer queue as a user message", async () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore
    .getState()
    .createTab(workspaceId, { type: "claude", props: { cwd: "/repo" } });
  const listen = spyOn(ipc, "ipcListen").mockImplementation(() => () => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  const target = agentTabController(workspaceId, tab.id);
  if (target?.agent !== "claude") throw new Error("expected a Claude tab");
  const key = chatKey(workspaceId, tab.id);
  const prepare = spyOn(target.controller, "prepareSend").mockResolvedValue(undefined);
  try {
    useChatStore
      .getState()
      .update(key, (prev) => ({ ...prev, model: { ...prev.model, running: true } }));
    const prompt = "Read this note again\n\n`nexus note read n1234567`";
    expect(await sendToConversation(workspaceId, tab.id, prompt)).toBe(true);
    expect(target.controller.state.queue).toEqual([
      { id: expect.any(String), text: prompt, images: [] },
    ]);
  } finally {
    prepare.mockRestore();
    target.controller.dispose();
    useTabsStore.getState().closeAllForWorkspace(workspaceId);
    listen.mockRestore();
    call.mockRestore();
  }
});
