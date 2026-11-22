import { expect, spyOn, test } from "bun:test";
import { type Editor, getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { taskSlug, uniqueName } from "../../../../../src/main/features/tasks/naming";
import { NoteSummaryAttributes } from "../../../../../src/renderer/components/notes/editor/extensions";
import * as agentTab from "../../../../../src/renderer/services/chat/agent-tab";
import * as placement from "../../../../../src/renderer/services/cli/placement";
import { notesApi } from "../../../../../src/renderer/services/notes/api";
import {
  assignNoteTask,
  canMakeTask,
  noteTaskPrompt,
  taskName,
} from "../../../../../src/renderer/services/notes/task";
import * as tasks from "../../../../../src/renderer/services/workspace/tasks";
import { useTabsStore } from "../../../../../src/renderer/state/stores/tabs";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
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

test.each([
  "not-a-repo",
  "not-connected",
] as const)("a worktree returning %s starts a linked conversation in the current workspace", async (kind) => {
  const workspace = { ...local, id: "123e4567-e89b-12d3-a456-426614174000", rootPath: "/repo" };
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
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Review" }],
                },
              ],
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
  const startTask = spyOn(tasks, "startTask").mockResolvedValue({ kind, message: kind });
  const open = spyOn(placement, "openTab").mockImplementation(
    (workspaceId, args) => useTabsStore.getState().createTab(workspaceId, args).id,
  );
  const add = spyOn(notesApi, "addLink").mockImplementation(
    async (_workspaceId, _noteId, link) => ({
      id: "l1234567",
      link: { ...link, createdAt: 0, updatedAt: 0 },
    }),
  );
  const start = spyOn(agentTab, "startAgentTab").mockImplementation(() => {
    expect(state.doc.nodeAt(1)?.attrs.nexusLink).toBe("l1234567");
  });
  try {
    await assignNoteTask(
      editor,
      1,
      { workspaceId: workspace.id, noteId: "n1234567", tabId: "notes" },
      () => "Weekly",
      async () => true,
      { agent: "codex", worktree: true },
    );
    expect(startTask).toHaveBeenCalledWith(
      workspace.id,
      "Review",
      expect.stringContaining("nexus note report"),
      { agent: "codex" },
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );
    expect(open).toHaveBeenCalledWith(
      workspace.id,
      { type: "codex", props: { cwd: "/repo" } },
      { background: true, besideTabId: "notes" },
    );
    expect(add).toHaveBeenCalledWith(
      workspace.id,
      "n1234567",
      expect.objectContaining({
        workspaceId: workspace.id,
        kind: "line",
        agent: "codex",
      }),
    );
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    startTask.mockRestore();
    open.mockRestore();
    add.mockRestore();
    start.mockRestore();
    useTabsStore.setState({ byWorkspace: tabs });
    useWorkspacesStore.setState({ workspaces });
  }
});
