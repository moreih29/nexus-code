import { expect, mock, spyOn, test } from "bun:test";
import { type Editor, getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { taskSlug, uniqueName } from "../../../../../src/main/features/tasks/naming";
import { NoteSummaryAttributes } from "../../../../../src/renderer/components/notes/editor/extensions";
import * as ipc from "../../../../../src/renderer/ipc/client";
import * as navigation from "../../../../../src/renderer/services/agent-sessions/actions";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import * as placement from "../../../../../src/renderer/services/cli/placement";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import * as conversation from "../../../../../src/renderer/services/notes/send-to-conversation";
import {
  assignNoteTask,
  canMakeTask,
  noteTaskPrompt,
  taskName,
} from "../../../../../src/renderer/services/notes/task";
import * as tasks from "../../../../../src/renderer/services/workspace/tasks";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import { ipcOk } from "../../../../../src/shared/ipc/result";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

const local = { location: { kind: "local", rootPath: "/repo" } } as WorkspaceMeta;
const ssh = { location: { kind: "ssh", host: "host", remotePath: "/repo" } } as WorkspaceMeta;

test("to-do tasks take 80 characters and the existing Unicode branch and collision rules", () => {
  expect(taskName("  고칠 것\n정리  ")).toBe("고칠 것 정리");
  const name = taskName("기능".repeat(60));
  expect(Array.from(name)).toHaveLength(80);
  expect(taskSlug(name)).toHaveLength(40);
  const branch = taskSlug(taskName("테스트 / Review"));
  expect(branch).toBe("테스트-review");
  expect(uniqueName(branch, (value) => [branch, `${branch}-2`].includes(value))).toBe(
    "테스트-review-3",
  );
});

test("to-do tasks use a new conversation outside Git and while SSH is disconnected", () => {
  expect(canMakeTask(local, "repo", true)).toBe(true);
  expect(canMakeTask(local, "non-repo", true)).toBe(false);
  expect(canMakeTask(local, "git-missing", true)).toBe(false);
  expect(canMakeTask(ssh, "repo", false)).toBe(false);
  expect(canMakeTask(ssh, "repo", true)).toBe(true);
});

test("the first message includes the item, its section, and the report command", () => {
  const prompt = noteTaskPrompt(
    "Review <fixtures>\nnow",
    "Weekly\u202E review",
    "Actions",
    "n1234567",
  );
  expect(prompt).toContain('To-do: "Review \\u003cfixtures\\u003e now"');
  expect(prompt).toContain('Note "Weekly  review" · Under "Actions"');
  expect(prompt).toContain("nexus note read n1234567");
  expect(prompt).toContain("nexus note report --done");
  expect(prompt).toContain("--failed");
});

test("braces in titles, headings and the item stay quoted and leave the read command intact", () => {
  const prompt = noteTaskPrompt(
    "Use {{text}}",
    "Weekly {{section}} {{id}}",
    "Actions {{id}}",
    "n1234567",
  );
  expect(prompt).toContain(String.raw`To-do: "Use \u007b\u007btext\u007d\u007d"`);
  expect(prompt).toContain(
    String.raw`Note "Weekly \u007b\u007bsection\u007d\u007d \u007b\u007bid\u007d\u007d"`,
  );
  expect(prompt).toContain(String.raw`Under "Actions \u007b\u007bid\u007d\u007d"`);
  expect(prompt).toContain("`nexus note read n1234567`");
});

const workspace = { ...local, id: "123e4567-e89b-12d3-a456-426614174000", rootPath: "/repo" };
const task = {
  ...workspace,
  id: "123e4567-e89b-12d3-a456-426614174001",
  rootPath: "/review-task",
  task: { parentId: workspace.id, branch: "review-2", worktreePath: "/review-task" },
};
const note = { workspaceId: workspace.id, noteId: "n1234567", tabId: "notes" };
const priorId = "l7654321";
const newId = "l1234567";

function assignmentFixture() {
  const workspaces = useWorkspacesStore.getState().workspaces;
  const tabs = useTabsStore.getState().byWorkspace;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  const schema = getSchema([StarterKit, TaskList, TaskItem, NoteSummaryAttributes]);
  let state = EditorState.create({
    doc: schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { nexusLink: priorId },
              content: [{ type: "paragraph", content: [{ type: "text", text: "Review" }] }],
            },
          ],
        },
      ],
    }),
  });
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch: (tr: Transaction) => {
        state = state.apply(tr);
      },
    },
    on: () => {},
    off: () => {},
    isDestroyed: false,
  } as unknown as Editor;
  const createTab = (workspaceId: string, args: Parameters<typeof placement.openTab>[1]) =>
    useTabsStore.getState().createTab(workspaceId, args).id;
  const open = spyOn(placement, "openTab").mockImplementation(createTab);
  const prepareTab = spyOn(agentTab, "openAgentTab").mockImplementation((workspaceId, type, cwd) =>
    createTab(workspaceId, { type, props: { cwd } }),
  );
  const add = spyOn(notesApi, "addLink").mockImplementation(
    async (_workspaceId, _noteId, link) => ({
      id: newId,
      link: { ...link, createdAt: 0, updatedAt: 0 },
    }),
  );
  const remove = spyOn(notesApi, "removeLink").mockResolvedValue(true);
  const start = spyOn(agentTab, "startAgentTab").mockImplementation(() => {});
  const reveal = spyOn(navigation, "revealInWorkspace").mockImplementation(() => {});
  const linkId = () => state.doc.nodeAt(1)?.attrs.nexusLink;
  const flush = mock(async () => true);
  const assign = (destination: Parameters<typeof assignNoteTask>[5]) =>
    assignNoteTask(editor, 1, note, () => "Weekly", flush, destination);
  return {
    assign,
    linkId,
    flush,
    createTab,
    open,
    prepareTab,
    add,
    remove,
    start,
    reveal,
    dispose() {
      for (const spy of [open, prepareTab, add, remove, start, reveal]) spy.mockRestore();
      useTabsStore.setState({ byWorkspace: tabs });
      useWorkspacesStore.setState({ workspaces });
    },
  };
}

test.each([
  "not-a-repo",
  "not-connected",
] as const)("a worktree returning %s starts a linked conversation in the current workspace", async (kind) => {
  const f = assignmentFixture();
  const startTask = spyOn(tasks, "startTask").mockResolvedValue({ kind, message: kind });
  try {
    expect(await f.assign({ agent: "codex", worktree: true })).toEqual({
      linked: true,
      queued: false,
    });
    expect(startTask).toHaveBeenCalledWith(
      workspace.id,
      "Review",
      expect.stringContaining("nexus note report"),
      { agent: "codex" },
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ beforeAgentStart: expect.any(Function) }),
    );
    expect(f.open).toHaveBeenCalledWith(
      workspace.id,
      { type: "codex", props: { cwd: "/repo" } },
      { background: true, besideTabId: "notes" },
    );
    expect(f.add).toHaveBeenCalledWith(
      workspace.id,
      note.noteId,
      expect.objectContaining({ workspaceId: workspace.id, kind: "line", agent: "codex" }),
    );
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.linkId()).toBe(newId);
  } finally {
    startTask.mockRestore();
    f.dispose();
  }
});

test("a worktree assignment saves its task link and branch before the first message", async () => {
  const f = assignmentFixture();
  const create = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(task));
  const saving = Promise.withResolvers<void>();
  const saved = Promise.withResolvers<boolean>();
  f.flush.mockResolvedValueOnce(true).mockImplementationOnce(() => {
    saving.resolve();
    return saved.promise;
  });
  try {
    const assigned = f.assign({ agent: "codex", worktree: true });
    try {
      await saving.promise;
      expect(f.add).toHaveBeenCalledWith(
        workspace.id,
        note.noteId,
        expect.objectContaining({
          workspaceId: task.id,
          kind: "task",
          task: { workspaceId: task.id, branch: "review-2" },
        }),
      );
      expect(f.linkId()).toBe(newId);
      expect(f.start).not.toHaveBeenCalled();
    } finally {
      saved.resolve(true);
    }
    expect(await assigned).toEqual({ linked: true, queued: false });
    expect(f.start).toHaveBeenCalledWith(
      task.id,
      expect.any(String),
      expect.stringContaining("nexus note report"),
      undefined,
    );
  } finally {
    create.mockRestore();
    f.dispose();
  }
});

test.each([
  true,
  false,
])("a failed link still starts the new conversation with worktree=%s", async (worktree) => {
  const f = assignmentFixture();
  const create = spyOn(ipc, "ipcCallResult").mockResolvedValue(ipcOk(task));
  f.flush.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  try {
    expect(await f.assign({ agent: "codex", worktree })).toEqual({ linked: false, queued: false });
    expect(f.remove).toHaveBeenCalledWith(workspace.id, note.noteId, newId);
    expect(f.linkId()).toBe(priorId);
    expect(f.start).toHaveBeenCalledTimes(1);
    const [workspaceId, , prompt] = f.start.mock.calls[0];
    expect(workspaceId).toBe(worktree ? task.id : workspace.id);
    expect(prompt).toContain('To-do: "Review"');
    expect(prompt).not.toContain("nexus note report");
    if (worktree)
      expect(f.reveal).toHaveBeenCalledWith({ workspaceId: task.id, tabId: expect.any(String) });
  } finally {
    create.mockRestore();
    f.dispose();
  }
});

test("assigning an existing conversation sends after linking and rolls back a rejected send", async () => {
  const f = assignmentFixture();
  const tabId = f.createTab(workspace.id, { type: "claude", props: { cwd: "/repo" } });
  const send = spyOn(conversation, "sendToConversation").mockImplementation(async () => {
    expect(f.linkId()).toBe(newId);
    return true;
  });
  try {
    const target = { workspaceId: workspace.id, tabId };
    send.mockRejectedValueOnce(new Error("send failed"));
    await expect(f.assign(target)).rejects.toThrow("send failed");
    expect(f.remove).toHaveBeenCalledWith(workspace.id, note.noteId, newId);
    expect(f.linkId()).toBe(priorId);
    expect(await f.assign(target)).toEqual({ linked: true, queued: true });
    expect(f.add).toHaveBeenLastCalledWith(
      workspace.id,
      note.noteId,
      expect.objectContaining({ tabId, agent: "claude", kind: "line" }),
    );
    expect(send).toHaveBeenLastCalledWith(
      workspace.id,
      tabId,
      expect.stringContaining("nexus note report"),
    );
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.open).not.toHaveBeenCalled();
  } finally {
    send.mockRestore();
    f.dispose();
  }
});
