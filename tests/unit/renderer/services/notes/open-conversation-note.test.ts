import { expect, spyOn, test } from "bun:test";
import * as ipc from "../../../../../src/renderer/ipc/client";
import { groupOf } from "../../../../../src/renderer/services/cli/placement";
import { openConversationNote } from "../../../../../src/renderer/services/notes/open-conversation-note";
import {
  findNoteTab,
  openClaudeTab,
  openCodexTab,
  openNewBrowserTab,
  openOrRevealNoteTab,
} from "../../../../../src/renderer/state/operations/tabs";
import { useActiveStore } from "../../../../../src/renderer/state/stores/active";
import { useAgentViewStore } from "../../../../../src/renderer/state/stores/agent-view";
import { findLeaf } from "../../../../../src/renderer/state/stores/layout/helpers";
import { useLayoutStore } from "../../../../../src/renderer/state/stores/layout/store";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";

const note = { noteId: "n1234567", title: "Release", updatedAt: 1 };

function activeTab(workspaceId: string, groupId: string) {
  return findLeaf(useLayoutStore.getState().byWorkspace[workspaceId].root, groupId)?.activeTabId;
}

function closeWorkspace(workspaceId: string) {
  useTabsStore.getState().closeAllForWorkspace(workspaceId);
  useLayoutStore.getState().closeAllForWorkspace(workspaceId);
}

test("opening from a workspace moves an existing note beside its Claude tab", () => {
  const workspaceId = crypto.randomUUID();
  const existing = openOrRevealNoteTab(workspaceId, note.noteId, note.title);
  const chat = openClaudeTab(workspaceId, { cwd: "/workspace" });
  try {
    openConversationNote(workspaceId, chat.id, note);
    const opened = findNoteTab(workspaceId, note.noteId);
    expect(opened?.tabId).toBe(existing.tabId);
    expect(opened?.groupId).not.toBe(existing.groupId);
    expect(activeTab(workspaceId, existing.groupId)).toBe(chat.id);
  } finally {
    closeWorkspace(workspaceId);
  }
});

test("opening from the agent view shows the Codex tab and its note in the task's workspace", () => {
  const root = crypto.randomUUID();
  const task = crypto.randomUUID();
  const active = useActiveStore.getState();
  const originalMode = useAgentViewStore.getState().mode;
  const ipcCall = spyOn(ipc, "ipcCallResult").mockResolvedValue({ ok: true, value: undefined });
  try {
    active.setActiveWorkspaceId(root);
    useAgentViewStore.getState().setMode("agents");
    const chat = openCodexTab(task, { cwd: "/workspace/task" });
    openNewBrowserTab(task);
    const chatGroup = groupOf(task, chat.id) ?? "";
    openConversationNote(task, chat.id, note);

    expect(useAgentViewStore.getState().mode).toBe("workspace");
    expect(useActiveStore.getState().activeWorkspaceId).toBe(task);
    expect(activeTab(task, chatGroup)).toBe(chat.id);
    const opened = findNoteTab(task, note.noteId);
    expect(opened).not.toBeNull();
    expect(opened?.groupId).not.toBe(chatGroup);
    expect(findNoteTab(root, note.noteId)).toBeNull();
  } finally {
    closeWorkspace(task);
    active.setActiveWorkspaceId(active.activeWorkspaceId);
    useAgentViewStore.getState().setMode(originalMode);
    ipcCall.mockRestore();
  }
});
