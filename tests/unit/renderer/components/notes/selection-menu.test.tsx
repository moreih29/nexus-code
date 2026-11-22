import { expect, mock, spyOn, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { AllSelection, EditorState } from "@tiptap/pm/state";
import * as tiptap from "@tiptap/react";
import * as menus from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { renderToStaticMarkup } from "react-dom/server";
import * as conversations from "../../../../../src/renderer/components/notes/conversation-chips";
import { NoteSelectionMenu } from "../../../../../src/renderer/components/notes/selection-menu";
import * as dropdown from "../../../../../src/renderer/components/ui/dropdown-menu";
import * as dialog from "../../../../../src/renderer/components/ui/prompt-dialog";
import * as toast from "../../../../../src/renderer/components/ui/toast";
import type { WorkspaceMeta } from "../../../../../src/shared/types/workspace";

test("the full-selection menu lists available destinations and rejects non-web links", () => {
  const schema = getSchema([StarterKit]);
  const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text("Excerpt")])]);
  const state = EditorState.create({ doc, selection: new AllSelection(doc) });
  const chain = mock();
  const editor = { state, chain, isEditable: true } as unknown as tiptap.Editor;
  const workspace = { id: "workspace" } as WorkspaceMeta;
  const link = {
    workspaceId: workspace.id,
    tabId: "tab",
    agent: "codex",
    cwd: "/repo",
    title: "Saved title",
    kind: "note",
    createdAt: 1,
    updatedAt: 1,
  } as const;
  const rows = {
    session: undefined,
    checking: false,
    hasStoredTurns: true,
    note: { workspaceId: workspace.id, noteId: "n1234567", tabId: "note-tab" },
    onUnavailable: () => {},
    result: undefined,
  };
  const readRows = spyOn(conversations, "useNoteConversationList").mockReturnValue([
    {
      ...rows,
      key: "l1234567",
      entry: { id: "l1234567", link },
      target: {
        kind: "open",
        workspace,
        tab: {
          type: "codex",
          id: "tab",
          title: "Review thread",
          defaultTitle: "Codex",
          isPinned: false,
          isPreview: false,
          props: { cwd: "/repo" },
        },
      },
    },
    {
      ...rows,
      key: "l1234568",
      entry: { id: "l1234568", link: { ...link, title: "Closed thread" } },
      target: { kind: "missing" },
    },
  ]);
  const menu = spyOn(menus, "BubbleMenu").mockImplementation(({ children }) => <>{children}</>);
  const marks = spyOn(tiptap, "useEditorState").mockReturnValue({
    bold: false,
    italic: false,
    link: false,
  });
  const root = spyOn(dropdown, "DropdownMenuRoot").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const trigger = spyOn(dropdown, "DropdownMenuTrigger").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const content = spyOn(dropdown, "DropdownMenuContent").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const item = spyOn(dropdown, "DropdownMenuItem").mockImplementation(({ children }) => (
    <div>{children}</div>
  ));
  const label = spyOn(dropdown, "DropdownMenuLabel").mockImplementation(({ children }) => (
    <>{children}</>
  ));
  const separator = spyOn(dropdown, "DropdownMenuSeparator").mockReturnValue(null);
  const prompt = spyOn(dialog, "PromptDialog").mockReturnValue(null);
  const notify = spyOn(toast, "showToast").mockImplementation(() => "");
  try {
    const markup = renderToStaticMarkup(
      <NoteSelectionMenu
        editor={editor}
        workspaceId={workspace.id}
        cwd="/repo"
        noteId="n1234567"
        title={() => "Notes"}
        flush={async () => true}
      />,
    );
    expect(markup).toContain("Review thread");
    expect(markup).toContain("Done");
    expect(markup).toContain("New Claude conversation");
    expect(markup).toContain("New Codex conversation");
    expect(markup).not.toContain("Closed thread");
    const shouldShow = menu.mock.calls[0][0].shouldShow!;
    expect(
      shouldShow({
        editor,
        state,
        view: { hasFocus: () => true } as Parameters<typeof shouldShow>[0]["view"],
        element: {} as HTMLElement,
        from: 0,
        to: doc.content.size,
      }),
    ).toBe(true);
    for (const unsafe of ["javascript:alert(0)", "data:text/html,unsafe"]) {
      prompt.mock.calls[0][0].onConfirm(unsafe);
    }
    expect(chain).not.toHaveBeenCalled();
    expect(notify.mock.calls).toEqual([
      [{ kind: "error", message: "HTTP or HTTPS URL" }],
      [{ kind: "error", message: "HTTP or HTTPS URL" }],
    ]);
  } finally {
    for (const spy of [
      readRows,
      menu,
      marks,
      root,
      trigger,
      content,
      item,
      label,
      separator,
      prompt,
      notify,
    ])
      spy.mockRestore();
  }
});
