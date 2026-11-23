import type { DocNode } from "./markdown";

export function headingText(node: DocNode): string {
  const text = (nodes: DocNode[] | undefined): string =>
    (nodes ?? []).map((n) => n.text ?? text(n.content)).join("");
  return text(node.content).replace(/\s+/g, " ").trim();
}

function levelOf(node: DocNode): number {
  return Number(node.attrs?.level) || 1;
}

export function insertionIndex(doc: DocNode, under?: string): number | null {
  const blocks = doc.content ?? [];
  if (under === undefined) return blocks.length;
  const wanted = under.replace(/\s+/g, " ").trim().toLowerCase();
  const at = blocks.findIndex(
    (b) => b.type === "heading" && headingText(b).toLowerCase() === wanted,
  );
  if (at === -1) return null;
  const level = levelOf(blocks[at] as DocNode);
  for (let i = at + 1; i < blocks.length; i++) {
    const b = blocks[i] as DocNode;
    if (b.type === "heading" && levelOf(b) <= level) return trimmedEnd(blocks, at + 1, i);
  }
  return trimmedEnd(blocks, at + 1, blocks.length);
}

function trimmedEnd(blocks: DocNode[], from: number, to: number): number {
  let end = to;
  while (end > from && isEmptyParagraph(blocks[end - 1] as DocNode)) end--;
  return end;
}

export function isEmptyParagraph(node: DocNode): boolean {
  return node.type === "paragraph" && !(node.content ?? []).length;
}

export function isEmptyDoc(doc: DocNode): boolean {
  const blocks = doc.content ?? [];
  return blocks.length === 0 || (blocks.length === 1 && isEmptyParagraph(blocks[0] as DocNode));
}

export function withBlocks(doc: DocNode, blocks: DocNode[], under?: string): DocNode | null {
  if (isEmptyDoc(doc) && under === undefined) return { ...doc, content: blocks };
  const at = insertionIndex(doc, under);
  if (at === null) return null;
  const content = [...(doc.content ?? [])];
  content.splice(at, 0, ...blocks);
  return { ...doc, content };
}

export function hasBlocksAt(doc: DocNode, index: number, blocks: DocNode[]): boolean {
  const content = doc.content ?? [];
  return (
    blocks.length > 0 &&
    blocks.every((b, i) => JSON.stringify(content[index + i]) === JSON.stringify(b))
  );
}
