import { describe, expect, test } from "bun:test";
import { imagesOf, markdownToBlocks } from "../../../../src/shared/notes/from-markdown";
import { hasBlocksAt, insertionIndex, withBlocks } from "../../../../src/shared/notes/insert";
import { type DocNode, docToMarkdown } from "../../../../src/shared/notes/markdown";

const text = (t: string, marks?: DocNode["marks"]): DocNode =>
  marks ? { type: "text", text: t, marks } : { type: "text", text: t };
const para = (...content: DocNode[]): DocNode => ({ type: "paragraph", content });
const heading = (level: number, t: string): DocNode => ({
  type: "heading",
  attrs: { level },
  content: [text(t)],
});

describe("markdownToBlocks", () => {
  test("headings, marks, links, lists, to-dos, quotes and code", () => {
    const blocks = markdownToBlocks(
      "#### Result\n\nSales **rose** *12%*, ~~not~~ `x` [here](https://a.b)  \nnext\n\n" +
        "- [x] sum up\n- [ ] share\n\n3. three\n   - inner\n\n> said\n\n```ts\nlet a\n```\n\n---\n",
    );
    expect(blocks).toEqual([
      heading(3, "Result"),
      para(
        text("Sales "),
        text("rose", [{ type: "bold" }]),
        text(" "),
        text("12%", [{ type: "italic" }]),
        text(", "),
        text("not", [{ type: "strike" }]),
        text(" "),
        text("x", [{ type: "code" }]),
        text(" "),
        text("here", [{ type: "link", attrs: { href: "https://a.b" } }]),
        { type: "hardBreak" },
        text("next"),
      ),
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [para(text("sum up"))] },
          { type: "taskItem", attrs: { checked: false }, content: [para(text("share"))] },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          {
            type: "listItem",
            content: [
              para(text("three")),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [para(text("inner"))] }],
              },
            ],
          },
        ],
      },
      { type: "blockquote", content: [para(text("said"))] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [text("let a")] },
      { type: "horizontalRule" },
    ]);
  });

  test("an image is a block of its own between its paragraph's text; a table stays as text", () => {
    const blocks = markdownToBlocks(
      "Before ![chart](out/chart.png) after\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    );
    expect(blocks).toEqual([
      para(text("Before")),
      { type: "noteImage", attrs: { src: "out/chart.png", alt: "chart" } },
      para(text("after")),
      {
        type: "codeBlock",
        attrs: { language: null },
        content: [text("| a | b |\n|---|---|\n| 1 | 2 |")],
      },
    ]);
    expect(imagesOf(blocks)).toEqual([blocks[1] as DocNode]);
  });

  test("a list with to-dos and plain items is cut where the kind changes: no box an item lacked", () => {
    const item = (t: string): DocNode => ({ type: "listItem", content: [para(text(t))] });
    const todo = (t: string, checked: boolean): DocNode => ({
      type: "taskItem",
      attrs: { checked },
      content: [para(text(t))],
    });
    expect(markdownToBlocks("- plain\n- [ ] to do\n- [x] done\n- after\n")).toEqual([
      { type: "bulletList", content: [item("plain")] },
      { type: "taskList", content: [todo("to do", false), todo("done", true)] },
      { type: "bulletList", content: [item("after")] },
    ]);
    expect(markdownToBlocks("4. four\n5. [ ] five\n6. six\n")).toEqual([
      { type: "orderedList", attrs: { start: 4 }, content: [item("four")] },
      { type: "taskList", content: [todo("five", false)] },
      { type: "orderedList", attrs: { start: 6 }, content: [item("six")] },
    ]);
  });

  test("reads back as the Markdown it came from", () => {
    const md = "## Plan\n\n- [ ] ask\n\n1. one\n2. two\n\n> **so**\n";
    expect(docToMarkdown({ type: "doc", content: markdownToBlocks(md) })).toBe(md);
    expect(markdownToBlocks("  \n\n")).toEqual([]);
  });
});

describe("where blocks go", () => {
  const doc: DocNode = {
    type: "doc",
    content: [
      heading(1, "Meeting"),
      para(text("intro")),
      heading(2, "Decisions"),
      para(text("one")),
      { type: "paragraph" },
      heading(2, "Next"),
      para(text("later")),
    ],
  };
  const added = para(text("new"));

  test("at the end, or at the end of a heading's part (any case), before its blank lines", () => {
    expect(insertionIndex(doc)).toBe(7);
    expect(insertionIndex(doc, "decisions")).toBe(4);
    expect(insertionIndex(doc, " Meeting ")).toBe(7);
    expect(insertionIndex(doc, "Nope")).toBeNull();
    expect(withBlocks(doc, [added], "Decisions")?.content?.[4]).toEqual(added);
    expect(withBlocks(doc, [added], "Nope")).toBeNull();
  });

  test("an empty note's one empty paragraph is replaced; blocks there already are told", () => {
    const empty: DocNode = { type: "doc", content: [{ type: "paragraph" }] };
    expect(withBlocks(empty, [added])).toEqual({ type: "doc", content: [added] });
    const done = withBlocks(doc, [added], "Decisions") as DocNode;
    expect(hasBlocksAt(done, 4, [added])).toBe(true);
    expect(hasBlocksAt(doc, 4, [added])).toBe(false);
  });
});
