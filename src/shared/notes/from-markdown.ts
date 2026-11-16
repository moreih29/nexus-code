/**
 * Markdown as a note's blocks: what an agent writes into a note (nexus note
 * write) made into the editor's document (ProseMirror JSON), as docToMarkdown
 * makes the document into Markdown the other way. GitHub's Markdown: task
 * lists, strikethrough; a table, which a note has no block for, stays as
 * its text in a code block. An image becomes a noteImage block whose src is
 * as written, for the caller to put the file in the note and set it.
 */
import type { PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { DocNode } from "./markdown";

type Mark = NonNullable<DocNode["marks"]>[number];

/** The note's blocks for `markdown`; none for blank text. */
export function markdownToBlocks(markdown: string): DocNode[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return blocksOf(tree.children, markdown);
}

/** The images among blocks (at any depth), as markdownToBlocks left them. */
export function imagesOf(blocks: DocNode[]): DocNode[] {
  return blocks.flatMap((b) => (b.type === "noteImage" ? [b] : imagesOf(b.content ?? [])));
}

function blocksOf(nodes: RootContent[], source: string): DocNode[] {
  return nodes.flatMap((node) => blockOf(node, source));
}

function blockOf(node: RootContent, source: string): DocNode[] {
  switch (node.type) {
    case "paragraph":
      return paragraphs(node.children);
    case "heading":
      return [
        withContent(
          { type: "heading", attrs: { level: Math.min(Math.max(node.depth, 1), 3) } },
          inline(node.children, []),
        ),
      ];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "blockquote":
      return [{ type: "blockquote", content: nonEmpty(blocksOf(node.children, source)) }];
    case "code":
      return [codeBlock(node.value, node.lang ?? null)];
    case "list": {
      const tasks = node.children.some((item) => typeof item.checked === "boolean");
      const items = node.children.map((item) => {
        const content = listItemContent(blocksOf(item.children, source));
        return tasks
          ? { type: "taskItem", attrs: { checked: item.checked === true }, content }
          : { type: "listItem", content };
      });
      if (tasks) return [{ type: "taskList", content: items }];
      return node.ordered
        ? [{ type: "orderedList", attrs: { start: node.start ?? 1 }, content: items }]
        : [{ type: "bulletList", content: items }];
    }
    case "table": {
      // No table block in a note: its Markdown as it was written.
      const { start, end } = node.position ?? {};
      const text =
        start?.offset !== undefined && end?.offset !== undefined
          ? source.slice(start.offset, end.offset)
          : "";
      return text ? [codeBlock(text, null)] : [];
    }
    case "html":
      return node.value.trim() ? [paragraph([{ type: "text", text: node.value }])] : [];
    default:
      // Definitions, footnotes and the like: their text, if they have any.
      return "children" in node ? blocksOf(node.children as RootContent[], source) : [];
  }
}

/** A list item's blocks, which start with a paragraph. */
function listItemContent(blocks: DocNode[]): DocNode[] {
  return blocks[0]?.type === "paragraph" ? blocks : [{ type: "paragraph" }, ...blocks];
}

function nonEmpty(blocks: DocNode[]): DocNode[] {
  return blocks.length > 0 ? blocks : [{ type: "paragraph" }];
}

function codeBlock(text: string, language: string | null): DocNode {
  return withContent(
    { type: "codeBlock", attrs: { language } },
    text ? [{ type: "text", text }] : [],
  );
}

function paragraph(content: DocNode[]): DocNode {
  return withContent({ type: "paragraph" }, content);
}

function withContent(node: DocNode, content: DocNode[]): DocNode {
  return content.length > 0 ? { ...node, content } : node;
}

/**
 * A paragraph's text, and its images as blocks of their own (a note's
 * images are blocks): the text before and after an image goes on either
 * side of it.
 */
function paragraphs(children: PhrasingContent[]): DocNode[] {
  const out: DocNode[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    const content = trimBreaks(inline(run, []));
    if (content.length > 0) out.push(paragraph(content));
    run = [];
  };
  for (const child of children) {
    if (child.type === "image") {
      flush();
      out.push({ type: "noteImage", attrs: { src: child.url, alt: child.alt ?? "" } });
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

/** Text without the line breaks and blanks an image left at its ends. */
function trimBreaks(content: DocNode[]): DocNode[] {
  const blank = (n: DocNode | undefined) =>
    n !== undefined && (n.type === "hardBreak" || (n.type === "text" && !n.text?.trim()));
  let from = 0;
  let to = content.length;
  while (from < to && blank(content[from])) from++;
  while (to > from && blank(content[to - 1])) to--;
  const kept = content.slice(from, to);
  // The space that stood beside the image goes with it.
  const first = kept[0];
  if (first?.type === "text") kept[0] = { ...first, text: (first.text ?? "").trimStart() };
  const last = kept.at(-1);
  if (last?.type === "text") kept[kept.length - 1] = { ...last, text: (last.text ?? "").trimEnd() };
  return kept.filter((n) => n.type !== "text" || n.text);
}

function inline(nodes: PhrasingContent[], marks: Mark[]): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    switch (node.type) {
      case "text":
        return textNode(node.value, marks);
      case "strong":
        return inline(node.children, [...marks, { type: "bold" }]);
      case "emphasis":
        return inline(node.children, [...marks, { type: "italic" }]);
      case "delete":
        return inline(node.children, [...marks, { type: "strike" }]);
      case "inlineCode":
        // Code takes no other mark in the editor.
        return textNode(node.value, [{ type: "code" }]);
      case "link":
        return inline(node.children, [...marks, { type: "link", attrs: { href: node.url } }]);
      case "break":
        return [{ type: "hardBreak" }];
      case "html":
        return textNode(node.value, marks);
      case "image":
        // Within a link or a heading: its words, as a note has no image there.
        return textNode(node.alt ?? "", marks);
      default:
        return "children" in node
          ? inline((node as { children: PhrasingContent[] }).children, marks)
          : [];
    }
  });
}

function textNode(text: string, marks: Mark[]): DocNode[] {
  // Soft line breaks read as spaces, as Markdown shows them.
  const flat = text.replace(/\n/g, " ");
  if (!flat) return [];
  return [marks.length > 0 ? { type: "text", text: flat, marks } : { type: "text", text: flat }];
}
