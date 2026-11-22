import { expect, mock, spyOn, test } from "bun:test";
import { type Editor, getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { NoteSummaryAttributes } from "../../../../../src/renderer/components/notes/editor/extensions";
import * as widgets from "../../../../../src/renderer/components/notes/editor/task-widgets";
import { NoteTaskControls } from "../../../../../src/renderer/components/notes/task-controls";
import * as dialog from "../../../../../src/renderer/components/ui/dialog";
import * as header from "../../../../../src/renderer/components/ui/dialog-header";
import * as select from "../../../../../src/renderer/components/ui/select";
import * as tasks from "../../../../../src/renderer/services/notes/task";
import { useTerminalStore } from "../../../../../src/renderer/state/stores/terminal";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";
import { withTestDom } from "../../../../helpers/test-dom";

test("the checklist marks each failure and excludes created but unlinked rows from a retry", async () => {
  const schema = getSchema([StarterKit, TaskList, TaskItem, NoteSummaryAttributes]);
  const row = (name: string, attrs = {}) =>
    schema.node("taskItem", attrs, [
      schema.node("paragraph", null, name ? [schema.text(name)] : []),
    ]);
  const list = schema.node("taskList", null, [
    row("Checked", { checked: true }),
    row("Linked", { nexusLink: "l1234567" }),
    row(""),
    ...Array.from({ length: 12 }, (_, i) => row(`Row ${i + 1}`)),
  ]);
  const state = EditorState.create({ doc: schema.node("doc", null, [list]) });
  const positions: number[] = [];
  list.forEach((_node, offset) => {
    positions.push(offset + 1);
  });
  const workspace = {
    id: "workspace",
    location: { kind: "local", rootPath: "/repo" },
  } as WorkspaceMeta;
  const workspaces = useWorkspacesStore.getState().workspaces;
  const preferred = useTerminalStore.getState().taskAgent;
  useWorkspacesStore.setState({ workspaces: [workspace] });
  useTerminalStore.setState({ taskAgent: "codex" });

  const show = spyOn(dialog, "Dialog").mockImplementation(({ children }) => <>{children}</>);
  const heading = spyOn(header, "DialogHeader").mockImplementation(({ description }) => (
    <p>{description}</p>
  ));
  const choice = spyOn(select, "Select").mockImplementation(({ children }) => <>{children}</>);
  const trigger = spyOn(select, "SelectTrigger").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const options = spyOn(select, "SelectContent").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const option = spyOn(select, "SelectItem").mockImplementation(({ children }) => <>{children}</>);
  const value = spyOn(select, "SelectValue").mockReturnValue(null);
  const probe = spyOn(tasks, "taskRepoKind").mockResolvedValue("repo");
  const first = Promise.withResolvers<{ linked: boolean; queued: boolean }>();
  const assign = spyOn(tasks, "assignNoteTask").mockImplementation(async (_editor, pos) => {
    if (pos === positions[3]) return first.promise;
    if (pos === positions[4]) throw new Error("Task creation failed");
    if (pos === positions[5]) return { linked: false, queued: false };
    return { linked: true, queued: false };
  });
  try {
    await withTestDom(async (host, root) => {
      const editor = {
        state,
        isDestroyed: false,
        view: {},
        on: mock(),
        off: mock(),
      } as unknown as Editor;
      const portal = (dataset: Record<string, string>) => {
        const element = document.createElement("div");
        Object.defineProperty(element, "dataset", { value: dataset });
        document.body.appendChild(element);
        return element;
      };
      const checklist = portal({ noteChecklist: "checklist" });
      const rows = positions.map((pos) => ({
        dom: portal({ noteTaskWidget: String(pos) }),
        taskPos: () => pos,
        speaker: "",
      }));
      const lists = spyOn(widgets, "checklistWidgets").mockReturnValue([
        { dom: checklist, listPos: () => 0 },
      ]);
      const items = spyOn(widgets, "taskWidgets").mockReturnValue(rows);
      const render = (canCreateTasks: boolean) =>
        root.render(
          <NoteTaskControls
            editor={editor}
            note={{ workspaceId: workspace.id, noteId: "n1234567", tabId: "note" }}
            title={() => "Planning"}
            flush={async () => true}
            onTranscript={() => {}}
            canCreateTasks={canCreateTasks}
          />,
        );
      try {
        await act(async () => render(false));
        expect(checklist.querySelector("button")).toBeFalsy();
        expect(lists).not.toHaveBeenCalled();

        await act(async () => render(true));
        const button = checklist.querySelector<HTMLButtonElement>("button");
        expect(button?.textContent).toBe("Create tasks from checklist");
        await act(async () => {
          button?.click();
        });
        expect(host.textContent).toContain("12 to-dos · Create 10 tasks");
        expect(host.textContent).toContain("First 10 only");
        expect(choice.mock.calls[0][0].value).toBe("codex");
        expect(
          Array.from(host.querySelectorAll("button"), ({ textContent }) => textContent),
        ).toEqual(["Cancel", "Create"]);
        await act(async () => {
          host.querySelector<HTMLButtonElement>("button")?.click();
        });
        expect(host.textContent).not.toContain("Create 10 tasks");
        expect(assign).not.toHaveBeenCalled();
        await act(async () => {
          button?.click();
        });
        const confirm = Array.from(host.querySelectorAll("button")).find(
          ({ textContent }) => textContent === "Create",
        );
        expect(confirm).toBeDefined();
        await act(async () => {
          confirm?.click();
        });
        expect(assign).toHaveBeenCalledTimes(1);
        await act(async () => first.resolve({ linked: true, queued: false }));
        expect(assign.mock.calls.map(([, pos]) => pos)).toEqual(positions.slice(3, 13));
        expect(assign.mock.calls[0].slice(-2)).toEqual([{ agent: "codex", worktree: true }, false]);
        const failed = rows.filter(({ dom }) =>
          dom.querySelector('[data-testid="note-task-failed"]'),
        );
        expect(failed).toEqual([rows[4]]);
        expect(
          rows[5].dom.querySelector('[data-testid="note-task-link-failed"]')?.textContent,
        ).toBe("To-do link failed");
        await act(async () => {
          button?.click();
        });
        expect(host.textContent).toContain("11 to-dos · Create 10 tasks");
        await act(async () => {
          Array.from(host.querySelectorAll("button"))
            .find(({ textContent }) => textContent === "Create")
            ?.click();
        });
        expect(assign.mock.calls.slice(10).map(([, pos]) => pos)).toEqual(
          positions.slice(3, 14).filter((pos) => pos !== positions[5]),
        );
      } finally {
        items.mockRestore();
        lists.mockRestore();
        await act(async () => root.render(null));
        for (const { dom } of rows) dom.remove();
        checklist.remove();
      }
    });
  } finally {
    for (const spy of [show, heading, choice, trigger, options, option, value, probe, assign])
      spy.mockRestore();
    useWorkspacesStore.setState({ workspaces });
    useTerminalStore.setState({ taskAgent: preferred });
  }
});
