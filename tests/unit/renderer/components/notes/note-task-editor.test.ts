import { expect, spyOn, test } from "bun:test";
import { createNodeFromContent, type Editor, getSchema } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { NoteSummaryAttributes } from "../../../../../src/renderer/components/notes/editor/extensions";
import { applyLineReport } from "../../../../../src/renderer/components/notes/editor/line-report";
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
  expect(applyLineReport(editor, report)).toBe(false);
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
