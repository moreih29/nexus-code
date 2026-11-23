import type { ListItem, PhrasingContent, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { DocNode } from "./markdown";

type Mark = NonNullable<DocNode["marks"]>[number];

export function markdownToBlocks(markdown: string, imageAlt?: string): DocNode[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return blocksOf(tree.children, markdown, imageAlt);
}

export function imagesOf(blocks: DocNode[]): DocNode[] {
  return blocks.flatMap((b) => (b.type === "noteImage" ? [b] : imagesOf(b.content ?? [])));
}

function blocksOf(nodes: RootContent[], source: string, imageAlt: string | undefined): DocNode[] {
  return nodes.flatMap((node) => blockOf(node, source, imageAlt));
}

function blockOf(node: RootContent, source: string, imageAlt: string | undefined): DocNode[] {
  switch (node.type) {
    case "paragraph":
      return paragraphs(node.children, imageAlt);
    case "heading":
      return [
        withContent(
          { type: "heading", attrs: { level: Math.min(Math.max(node.depth, 1), 3) } },
          inline(node.children, [], imageAlt),
        ),
      ];
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "blockquote":
      return [{ type: "blockquote", content: nonEmpty(blocksOf(node.children, source, imageAlt)) }];
    case "code":
      return [codeBlock(node.value, node.lang ?? null)];
    case "list": {
      const runs: ListItem[][] = [];
      for (const item of node.children) {
        const run = runs.at(-1);
        if (run?.[0] && isTask(run[0]) === isTask(item)) run.push(item);
        else runs.push([item]);
      }
      let start = node.start ?? 1;
      return runs.map((run) => {
        const tasks = isTask(run[0]);
        const items = run.map((item) => {
          const content = listItemContent(blocksOf(item.children, source, imageAlt));
          return tasks
            ? { type: "taskItem", attrs: { checked: item.checked === true }, content }
            : { type: "listItem", content };
        });
        const at = start;
        start += run.length;
        if (tasks) return { type: "taskList", content: items };
        return node.ordered
          ? { type: "orderedList", attrs: { start: at }, content: items }
          : { type: "bulletList", content: items };
      });
    }
    case "table": {
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
      return "children" in node ? blocksOf(node.children as RootContent[], source, imageAlt) : [];
  }
}

function isTask(item: ListItem | undefined): boolean {
  return typeof item?.checked === "boolean";
}

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

function paragraphs(children: PhrasingContent[], imageAlt: string | undefined): DocNode[] {
  const out: DocNode[] = [];
  let run: PhrasingContent[] = [];
  const flush = () => {
    const content = trimBreaks(inline(run, [], imageAlt));
    if (content.length > 0) out.push(paragraph(content));
    run = [];
  };
  for (const child of children) {
    if (child.type === "image" && imageAlt === undefined) {
      flush();
      out.push({ type: "noteImage", attrs: { src: child.url, alt: child.alt ?? "" } });
    } else {
      run.push(child);
    }
  }
  flush();
  return out;
}

function trimBreaks(content: DocNode[]): DocNode[] {
  const blank = (n: DocNode | undefined) =>
    n !== undefined && (n.type === "hardBreak" || (n.type === "text" && !n.text?.trim()));
  let from = 0;
  let to = content.length;
  while (from < to && blank(content[from])) from++;
  while (to > from && blank(content[to - 1])) to--;
  const kept = content.slice(from, to);
  const first = kept[0];
  if (first?.type === "text") kept[0] = { ...first, text: (first.text ?? "").trimStart() };
  const last = kept.at(-1);
  if (last?.type === "text") kept[kept.length - 1] = { ...last, text: (last.text ?? "").trimEnd() };
  return kept.filter((n) => n.type !== "text" || n.text);
}

function inline(nodes: PhrasingContent[], marks: Mark[], imageAlt: string | undefined): DocNode[] {
  return nodes.flatMap((node): DocNode[] => {
    switch (node.type) {
      case "text":
        return textNode(node.value, marks);
      case "strong":
        return inline(node.children, [...marks, { type: "bold" }], imageAlt);
      case "emphasis":
        return inline(node.children, [...marks, { type: "italic" }], imageAlt);
      case "delete":
        return inline(node.children, [...marks, { type: "strike" }], imageAlt);
      case "inlineCode":
        return textNode(node.value, [{ type: "code" }]);
      case "link":
        return inline(
          node.children,
          [...marks, { type: "link", attrs: { href: node.url } }],
          imageAlt,
        );
      case "break":
        return [{ type: "hardBreak" }];
      case "html":
        return textNode(node.value, marks);
      case "image":
        return textNode(
          imageAlt === undefined ? (node.alt ?? "") : node.alt?.trim() || imageAlt,
          marks,
        );
      case "imageReference":
        return imageAlt === undefined ? [] : textNode(node.alt?.trim() || imageAlt, marks);
      default:
        return "children" in node
          ? inline((node as { children: PhrasingContent[] }).children, marks, imageAlt)
          : [];
    }
  });
}

function textNode(text: string, marks: Mark[]): DocNode[] {
  const flat = text.replace(/\n/g, " ");
  if (!flat) return [];
  return [marks.length > 0 ? { type: "text", text: flat, marks } : { type: "text", text: flat }];
}
