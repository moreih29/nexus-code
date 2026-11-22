import { expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { NoteSummaryAttributes } from "../../../../../src/renderer/components/notes/editor/extensions";
import { NoteTaskWidgets } from "../../../../../src/renderer/components/notes/editor/task-widgets";
import { NoteTaskControls } from "../../../../../src/renderer/components/notes/task-controls";
import { useWorkspacesStore } from "../../../../../src/renderer/state/stores/workspaces";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";
import { withTestDom } from "../../../../helpers/test-dom";

/**
 * Domino has neither `dataset` nor `append`; the editor's widgets and TaskItem use both.
 * Domino's prototypes are shared by every test file, so each new element gets its own.
 */
function bridgeDom() {
  const attr = (key: string) => `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const create = document.createElement.bind(document);
  Object.defineProperty(document, "createElement", {
    configurable: true,
    value(tag: string, options?: ElementCreationOptions) {
      const element = create(tag, options);
      Object.defineProperty(element, "append", {
        value(...children: Node[]) {
          for (const child of children) element.appendChild(child);
        },
      });
      const dataset = new Proxy(
        {},
        {
          get: (_target, key: string) => element.getAttribute(attr(key)) ?? undefined,
          set: (_target, key: string, value) => {
            element.setAttribute(attr(key), String(value));
            return true;
          },
        },
      );
      Object.defineProperty(element, "dataset", { value: dataset });
      return element;
    },
  });
}

test("the task widget is filled again when the editor redraws it without a transaction", async () => {
  const workspaces = useWorkspacesStore.getState().workspaces;
  useWorkspacesStore.setState({
    workspaces: [{ id: "w", location: { kind: "local", rootPath: "/repo" } } as WorkspaceMeta],
  });
  try {
    await withTestDom(async (host, root) => {
      bridgeDom();
      const holder = document.createElement("div");
      host.appendChild(holder);
      const editor = new Editor({
        element: holder,
        extensions: [StarterKit, TaskList, TaskItem, NoteSummaryAttributes, NoteTaskWidgets],
        content: {
          type: "doc",
          content: [
            {
              type: "taskList",
              content: [
                {
                  type: "taskItem",
                  attrs: { checked: false },
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Ship" }] }],
                },
              ],
            },
          ],
        },
      });
      const widget = () => editor.view.dom.querySelector("[data-note-task-widget]");
      try {
        await act(async () =>
          root.render(
            <NoteTaskControls
              editor={editor}
              note={{ workspaceId: "w", noteId: "n1234567", tabId: "note" }}
              title={() => "Planning"}
              flush={async () => true}
              onTranscript={() => {}}
              canCreateTasks
            />,
          ),
        );
        const first = widget();
        expect(first?.textContent).toBe("To a task");

        let transactions = 0;
        editor.on("transaction", () => transactions++);
        // A new node view set makes ProseMirror rebuild the document DOM, widgets included.
        await act(async () => {
          editor.view.setProps({
            nodeViews: { ...editor.view.props.nodeViews, paragraph: undefined as never },
          });
        });
        expect(transactions).toBe(0);
        expect(widget()).not.toBe(first);
        expect(widget()?.textContent).toBe("To a task");
      } finally {
        await act(async () => root.unmount());
        editor.destroy();
      }
    });
  } finally {
    useWorkspacesStore.setState({ workspaces });
  }
});
