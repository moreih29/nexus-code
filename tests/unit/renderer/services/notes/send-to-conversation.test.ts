import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import * as chatPlacement from "../../../../../src/renderer/services/chat/open-beside";
import { chatKey, useChatStore } from "../../../../../src/renderer/services/chat/store";
import * as submission from "../../../../../src/renderer/services/chat/transport/submission";
import * as placement from "../../../../../src/renderer/services/cli/placement";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import { sendNoteSelection } from "../../../../../src/renderer/services/notes/send-selection";
import { sendToConversation } from "../../../../../src/renderer/services/notes/send-to-conversation";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

test("a note sent to a running Claude tab goes to its composer queue as a user message", async () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore
    .getState()
    .createTab(workspaceId, { type: "claude", props: { cwd: "/repo" } });
  const listen = spyOn(ipc, "ipcListen").mockImplementation(() => () => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  const target = agentTab.agentTabController(workspaceId, tab.id);
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

test("a selected excerpt goes through the existing turn queue and touches a note-level link", async () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore
    .getState()
    .createTab(workspaceId, { type: "claude", props: { cwd: "/repo" } });
  const listen = spyOn(ipc, "ipcListen").mockImplementation(() => () => {});
  const call = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  const target = agentTab.agentTabController(workspaceId, tab.id);
  if (target?.agent !== "claude") throw new Error("expected a Claude tab");
  const prepare = spyOn(target.controller, "prepareSend").mockResolvedValue(undefined);
  const add = spyOn(notesApi, "addLink").mockResolvedValue({
    id: "l1234567",
    link: {
      agent: "claude",
      workspaceId,
      tabId: tab.id,
      cwd: "/repo",
      title: "Chat",
      kind: "selection",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  try {
    useChatStore.getState().update(chatKey(workspaceId, tab.id), (prev) => ({
      ...prev,
      model: { ...prev.model, running: true },
    }));
    expect(
      await sendNoteSelection(
        { workspaceId, noteId: "n1234567", title: "Release" },
        "Keep the API\nCheck the tests",
        { agent: "claude", workspaceId, tabId: tab.id, linkId: "l1234567" },
      ),
    ).toEqual({ queued: true, linked: true });
    expect(target.controller.state.queue).toMatchObject([
      {
        text: "Take a look at this part.\n\nSelected text from the note ‘Release’:\n> Keep the API\n> Check the tests\n\nNote ‘Release’: read it with `nexus note read n1234567`.",
        images: [],
      },
    ]);
    expect(add).toHaveBeenCalledWith(
      workspaceId,
      "n1234567",
      expect.objectContaining({ kind: "selection", tabId: tab.id }),
      "l1234567",
    );
  } finally {
    add.mockRestore();
    prepare.mockRestore();
    target.controller.dispose();
    useTabsStore.getState().closeAllForWorkspace(workspaceId);
    listen.mockRestore();
    call.mockRestore();
  }
});

test("a new Codex conversation is linked only after it accepts the selected text", async () => {
  const workspaceId = crypto.randomUUID();
  const tab = useTabsStore
    .getState()
    .createTab(workspaceId, { type: "codex", props: { cwd: "/repo" } });
  const target = { agent: "codex" } as NonNullable<ReturnType<typeof agentTab.agentTabController>>;
  const controller = spyOn(agentTab, "agentTabController").mockReturnValue(target);
  const open = spyOn(placement, "openTab").mockReturnValue(tab.id);
  const reveal = spyOn(chatPlacement, "revealTabById").mockImplementation(() => {});
  const accepted = Promise.withResolvers<void>();
  const send = spyOn(submission, "sendFirstMessage").mockReturnValue(accepted.promise);
  const link = spyOn(notesApi, "addLink").mockImplementation(async (_, __, data) => ({
    id: "l1234567",
    link: { ...data, createdAt: 1, updatedAt: 1 },
  }));
  const note = { workspaceId, noteId: "n1234567", title: "Review" };
  try {
    const sending = sendNoteSelection(note, "Keep this test", { agent: "codex", cwd: "/repo" });
    expect(send).toHaveBeenCalledWith(
      workspaceId,
      tab.id,
      target,
      expect.stringContaining("> Keep this test"),
    );
    expect(link).not.toHaveBeenCalled();
    accepted.resolve();
    expect(await sending).toEqual({ queued: false, linked: true });
    expect(link).toHaveBeenCalledWith(
      workspaceId,
      note.noteId,
      expect.objectContaining({
        kind: "selection",
        agent: "codex",
        tabId: tab.id,
      }),
      undefined,
    );
    send.mockRejectedValue(new Error("Could not start Codex"));
    await expect(
      sendNoteSelection(note, "Keep this test", { agent: "codex", cwd: "/repo" }),
    ).rejects.toThrow("Could not start Codex");
    expect(link).toHaveBeenCalledTimes(1);
  } finally {
    link.mockRestore();
    send.mockRestore();
    reveal.mockRestore();
    open.mockRestore();
    controller.mockRestore();
    useTabsStore.getState().closeAllForWorkspace(workspaceId);
  }
});
