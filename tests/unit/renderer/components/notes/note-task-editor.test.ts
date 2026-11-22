import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createWindow } from "@mixmark-io/domino";
import { createNodeFromContent, Editor, getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { history, undo } from "@tiptap/pm/history";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import StarterKit from "@tiptap/starter-kit";
import {
  applyAnswerCard,
  NoteAnswerWidgets,
  setLiveCardLinks,
} from "../../../../../src/renderer/components/notes/editor/answer-card";
import {
  NoteSummaryAttributes,
  NoteTaskItem,
} from "../../../../../src/renderer/components/notes/editor/extensions";
import { applyLineReport } from "../../../../../src/renderer/components/notes/editor/line-report";
import { createNoteDocumentRevision } from "../../../../../src/renderer/services/notes/document-inbox";
import {
  answerCard,
  answerCardBlocks,
  withAnswerCard,
} from "../../../../../src/shared/notes/answer-card";
import {
  type LineReport,
  linkedTask,
  withLineReport,
} from "../../../../../src/shared/notes/line-report";
import { type DocNode, docToMarkdown } from "../../../../../src/shared/notes/markdown";

const base = [StarterKit, TaskList, TaskItem.configure({ nested: true })];
const current = getSchema([...base, NoteSummaryAttributes]);
const legacy = getSchema(base);
const linkId = "l1234567";
const paragraph = (text: string): DocNode => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const doc: DocNode = {
  type: "doc",
  content: [
    paragraph("Unsaved notes"),
    {
      type: "taskList",
      attrs: { nexusOrigin: "summary:r1234567" },
      content: [
        {
          type: "taskItem",
          attrs: { checked: false, nexusLink: linkId, nexusSpeaker: "한여울", nexusAt: 45000 },
          content: [paragraph("Add tests")],
        },
        { type: "taskItem", attrs: { checked: false }, content: [paragraph("Ship")] },
      ],
    },
  ],
};

test("new attributes survive JSON and disappear from legacy text and copy markup", () => {
  const saved = current.nodeFromJSON(doc);
  const copy = ProseMirrorNode.fromJSON(legacy, saved.toJSON());
  const task = saved.child(1).child(0);
  expect(copy.textContent).toBe(saved.textContent);
  expect(copy.child(1).child(0).attrs.nexusLink).toBeUndefined();
  expect(task.attrs.nexusLink).toBe(linkId);
  expect(JSON.stringify(task.type.spec.toDOM?.(task))).toContain('"data-type":"taskItem"');
  expect(JSON.stringify(task.type.spec.toDOM?.(task))).not.toContain(linkId);
  expect(JSON.stringify(task.type.spec.toDOM?.(task))).not.toContain("한여울");
  expect(docToMarkdown(saved.toJSON())).toContain("- [ ] Add tests — 한여울 0:45");
  expect(createNodeFromContent(saved.toJSON(), legacy, { slice: false })).toEqual(copy);
});

test("this TipTap version falls back to an empty document for an unknown node", () => {
  const original = globalThis.window;
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // The invalid JSON falls back through the HTML parser only for the empty string.
    globalThis.window = Object.assign({}, original, {
      DOMParser: class {
        parseFromString() {
          return { body: { firstChild: null, childNodes: [] } };
        }
      },
    }) as unknown as Window & typeof globalThis;
    const unknown = { type: "doc", content: [paragraph("Text"), { type: "unexpectedNode" }] };
    expect(() => ProseMirrorNode.fromJSON(legacy, unknown)).toThrow("Unknown node type");
    const fallback = createNodeFromContent(unknown, legacy, { slice: false });
    expect(fallback.toJSON()).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
    expect(warning).toHaveBeenCalled();
  } finally {
    globalThis.window = original;
    warning.mockRestore();
  }
});

test("lineReported merges in the open editor and preserves unsaved text and selection", () => {
  let state = EditorState.create({ doc: current.nodeFromJSON(doc) });
  const edit = state.tr.insertText("New ", 1);
  state = state.apply(edit.setSelection(TextSelection.create(edit.doc, 3)));
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  const report: LineReport = {
    linkId,
    check: true,
    result: {
      state: "done",
      summary: "Tests passed",
      pr: { number: 128, url: "https://example.test/pull/128" },
      at: 1,
    },
  };
  const initial = state.doc.toJSON() as DocNode;
  expect(applyLineReport(editor, report)).toBe(true);
  const main = current.nodeFromJSON(withLineReport(initial, report));
  expect(state.doc.eq(main)).toBe(true);
  expect(state.doc.firstChild?.textContent).toBe("New Unsaved notes");
  expect(state.selection.from).toBe(3);
  expect(applyLineReport(editor, report)).toBe(true);
  expect(
    applyLineReport(editor, {
      ...report,
      check: false,
      result: { state: "failed", summary: "Blocked", at: 2 },
    }),
  ).toBe(true);
  expect(linkedTask(state.doc.toJSON(), linkId)?.content).toHaveLength(2);
  expect(applyLineReport(editor, { ...report, linkId: "l0000000" })).toBe(false);
});

function taskEditor(content: DocNode) {
  return new Editor({
    element: null,
    extensions: [StarterKit, TaskList, NoteTaskItem, NoteSummaryAttributes],
    content,
  });
}

test("the checked and hover CSS selectors match the editable TaskItem NodeView", () => {
  const page = createWindow('<div class="note-doc"><ul data-type="taskList"></ul></div>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  // Domino implements the DOM selectors. Bridge the NodeView's dataset write to its attribute.
  Object.defineProperty(page.HTMLElement.prototype, "dataset", {
    get(this: HTMLElement) {
      const element = this;
      return {
        set checked(value: boolean) {
          element.setAttribute("data-checked", String(value));
        },
      };
    },
  });
  Object.defineProperty(page.Element.prototype, "append", {
    value(this: Element, ...children: Node[]) {
      for (const child of children) this.appendChild(child);
    },
  });
  const editor = taskEditor(
    withLineReport(doc, {
      linkId,
      check: true,
      result: { state: "done", summary: "Done", at: 1 },
    }),
  );
  try {
    Object.defineProperty(globalThis, "document", { configurable: true, value: page.document });
    const node = editor.state.doc.child(1).child(0);
    const nodeView = editor.extensionManager.nodeViews.taskItem(
      node,
      editor.view,
      () => editor.state.doc.firstChild!.nodeSize + 1,
      [],
      DecorationSet.empty,
    );
    const content = nodeView.contentDOM!;
    content.innerHTML =
      '<p>Add tests <button class="note-task-action">To a task</button></p><p class="note-task-report">Done</p>';
    page.document.querySelector("ul")!.appendChild(nodeView.dom);
    const styles = readFileSync(
      new URL("../../../../../src/renderer/styles/globals.css", import.meta.url),
      "utf8",
    );
    const checked =
      /([^{}]+)\{\s*color: var\(--editor-text-muted\);\s*text-decoration: line-through;/
        .exec(styles)?.[1]
        ?.trim()
        .replace(/\s+/g, " ");
    const hover = Array.from(styles.matchAll(/([^{}]+)\{\s*opacity: 1;/g))
      .map(([, selectors]) => selectors.split(",")[0]?.trim())
      .find((selector) => selector?.includes(".note-task-action"));
    expect(checked).toBeDefined();
    expect(hover).toContain(":hover");
    // DOM query engines expose structural matching without a mouse pointer.
    const hoverTarget = hover!.replace(/:not\(:has\([^)]*\)\)|:hover/g, "").replace(/\s+/g, " ");
    expect(page.document.querySelector(checked!)).toBe(content.firstElementChild);
    expect(page.document.querySelector(hoverTarget)).toBe(content.querySelector("button"));
    const unchecked = node.type.create({ ...node.attrs, checked: false }, node.content);
    expect(nodeView.update?.(unchecked, [], DecorationSet.empty)).toBe(true);
    expect(page.document.querySelectorAll(checked!)).toHaveLength(0);
    expect(page.document.querySelector(hoverTarget)).toBe(content.querySelector("button"));
  } finally {
    editor.destroy();
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("Enter midway through a result leaves the new task paragraph without report origin", () => {
  const editor = taskEditor(
    withLineReport(doc, {
      linkId,
      check: true,
      result: { state: "done", summary: "Before after", at: 1 },
    }),
  );
  try {
    let position = 0;
    editor.state.doc.descendants((node, at) => {
      if (node.attrs.nexusOrigin === `report:${linkId}`) position = at + 1;
    });
    expect(editor.commands.setTextSelection(position + "Before ".length)).toBe(true);
    const enter = { key: "Enter" } as KeyboardEvent;
    expect(
      editor.extensionManager.plugins.some((plugin) =>
        plugin.props.handleKeyDown?.call(plugin, editor.view, enter),
      ),
    ).toBe(true);
    const list = editor.state.doc.child(1);
    expect(list.child(0).child(1).attrs.nexusOrigin).toBe(`report:${linkId}`);
    expect(list.child(0).child(1).textContent).toBe("Before ");
    expect(list.child(1).attrs.nexusLink).toBeNull();
    expect(list.child(1).firstChild?.attrs.nexusOrigin).toBeNull();
    expect(list.child(1).textContent).toBe("after");
  } finally {
    editor.destroy();
  }
});

test("a saved answer is a legacy-compatible quote with safe links, image alt text and code", () => {
  const markdown = [
    "# Check",
    "",
    "See ![diagram](file:///secret) and ![](https://example.com/photo.png).",
    "",
    "![Reference image][image]",
    "",
    "[image]: https://example.com/reference.png",
    "",
    "[OK](https://example.com/a(b)) · [bad](java&#x73;cript:alert%281%29)",
    "",
    "\\![link](https://example.com/image.png)",
    "",
    "<iframe src=https://example.com/>",
    "",
    "````ts",
    "const fence = '```';",
    "~~~",
    "",
    "",
    "</code>",
    "````",
  ].join("\n");
  const card = answerCard(linkId, answerCardBlocks(markdown, "Image"));
  const saved = current.nodeFromJSON({ type: "doc", content: [card] });
  saved.check();
  const old = legacy.nodeFromJSON(saved.toJSON());
  expect(old.firstChild?.attrs.nexusLink).toBeUndefined();
  expect(old.textContent).toBe(saved.textContent);
  expect(old.textContent).toContain("See diagram and Image.");
  expect(old.textContent).toContain("Reference image");
  expect(old.textContent).toContain("const fence = '```';\n~~~\n\n\n</code>");
  const output = docToMarkdown(saved.toJSON());
  expect(output).toContain("> # Check");
  expect(output).toContain("[OK](https://example.com/a%28b%29) · bad");
  expect(output).toContain(String.raw`\<iframe src=https://example.com/\>`);
  expect(output).toContain(String.raw`\![link](https://example.com/image.png)`);
  expect(output).toContain("> ~~~~ts");
  expect(output).not.toContain(linkId);
  expect(output).not.toContain("javascript:");
  expect(output).not.toContain("file:///secret");
  expect(output).not.toContain("photo.png");
});

test("a card append keeps local edits and selection, and is safe to apply twice", () => {
  const card = answerCard(linkId, [paragraph("The answer")]);
  let state = EditorState.create({ doc: current.nodeFromJSON(doc), plugins: [history()] });
  const edit = state.tr.insertText("New ", 1);
  state = state.apply(edit.setSelection(TextSelection.create(edit.doc, 3)));
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch(tr: Transaction) {
        state = state.apply(tr);
      },
    },
  } as unknown as Editor;
  expect(applyAnswerCard(editor, card)).toBe(true);
  expect(applyAnswerCard(editor, card)).toBe(true);
  expect(state.selection.from).toBe(3);
  expect(state.doc.firstChild?.textContent).toBe("New Unsaved notes");
  expect(state.doc.lastChild?.textContent).toBe("The answer");
  expect(state.doc.toJSON()).toEqual(
    current
      .nodeFromJSON(
        withAnswerCard(
          { ...doc, content: [paragraph("New Unsaved notes"), ...(doc.content ?? []).slice(1)] },
          card,
        ),
      )
      .toJSON(),
  );
  expect(
    undo(state, (tr) => {
      state = state.apply(tr);
    }),
  ).toBe(true);
  expect(state.doc.firstChild?.textContent).toBe("Unsaved notes");
  expect(state.doc.lastChild?.textContent).toBe("The answer");
});

test("an unapplied card or line report keeps the disk merge base in place", () => {
  const state = EditorState.create({ doc: current.nodeFromJSON(doc) });
  const editor = { state, view: { dispatch: () => {} } } as unknown as Editor;
  const card = answerCard(linkId, [paragraph("A card from disk")]);
  const cardRevision = createNoteDocumentRevision(1);
  cardRevision.apply(2, () => applyAnswerCard(editor, card));
  cardRevision.apply(3, () => true);
  expect(cardRevision.updatedAt).toBe(1);

  const reportRevision = createNoteDocumentRevision(1);
  reportRevision.apply(2, () => {
    expect(reportRevision.updatedAt).toBe(1);
    return true;
  });
  reportRevision.apply(3, () =>
    applyLineReport(editor, {
      linkId,
      check: true,
      result: { state: "done", summary: "Tests passed", at: 3 },
    }),
  );
  expect(reportRevision.updatedAt).toBe(2);
});

test("an old editor reads a live card as an ordinary one-line title quote", () => {
  const card = answerCard(linkId, [paragraph("Review [logs]")]);
  const stored = current.nodeFromJSON({ type: "doc", content: [card] });
  const old = legacy.nodeFromJSON(stored.toJSON());
  old.check();
  expect(old.firstChild?.attrs.nexusLink).toBeUndefined();
  expect(old.textContent).toBe("Review [logs]");
  expect(docToMarkdown(stored.toJSON())).toBe("> Review \\[logs\\]\n");
});

test("the editor skips hidden live titles in both directions and selects a lone card as a block", () => {
  const holder = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      NoteSummaryAttributes,
      NoteAnswerWidgets,
    ],
    content: { type: "doc", content: [paragraph("Initial")] },
  });
  const make = (content: DocNode[], initial?: number) => {
    const doc = holder.schema.nodeFromJSON({ type: "doc", content });
    const positions: number[] = [];
    doc.forEach((_node, offset) => {
      positions.push(offset);
    });
    let state = EditorState.create({
      doc,
      plugins: holder.extensionManager.plugins,
      ...(initial === undefined ? {} : { selection: TextSelection.create(doc, initial) }),
    });
    const dispatch = (tr: Transaction) => {
      state = state.apply(tr);
    };
    const editor = {
      get state() {
        return state;
      },
      view: { dispatch },
      isDestroyed: false,
    } as unknown as Editor;
    return { positions, editor, dispatch };
  };
  try {
    const title = answerCard(linkId, [paragraph("Hidden title")]);
    const second = answerCard("l1234568", [paragraph("Another hidden title")]);
    const saved = answerCard("l1234569", [paragraph("Saved answer text")]);
    const { positions, editor, dispatch } = make([paragraph("Before"), title, second, saved]);
    setLiveCardLinks(editor, new Set([linkId, "l1234568"]));
    dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, positions[1] + 2)),
    );
    expect(editor.state.selection.$head.parent.textContent).toBe("Saved answer text");
    dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, positions[2] + 2)),
    );
    expect(editor.state.selection.$head.parent.textContent).toBe("Before");

    const only = make([title], 2);
    setLiveCardLinks(only.editor, new Set([linkId]));
    expect(only.editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(only.editor.state.selection.from).toBe(0);
  } finally {
    holder.destroy();
  }
});
