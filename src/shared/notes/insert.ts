/**
 * Where blocks put into a note go: at its end, or at the end of the part
 * under one of its headings. The same for the note's file (the app's main
 * process) and an editor open on it, so both put them in the same place.
 */
import type { DocNode } from "./markdown";

/** A heading's text, as it reads. */
export function headingText(node: DocNode): string {
  const text = (nodes: DocNode[] | undefined): string =>
    (nodes ?? []).map((n) => n.text ?? text(n.content)).join("");
  return text(node.content).replace(/\s+/g, " ").trim();
}

function levelOf(node: DocNode): number {
  return Number(node.attrs?.level) || 1;
}

/**
 * The index among the document's top blocks that new ones go at: its end;
 * or, `under` a heading (its text, any case), the end of its part, before
 * the next heading as high or higher. Null when no heading has that text.
 */
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

/** The end of a part, before the empty paragraphs it ends with. */
function trimmedEnd(blocks: DocNode[], from: number, to: number): number {
  let end = to;
  while (end > from && isEmptyParagraph(blocks[end - 1] as DocNode)) end--;
  return end;
}

export function isEmptyParagraph(node: DocNode): boolean {
  return node.type === "paragraph" && !(node.content ?? []).length;
}

/** Whether a document is empty: nothing, or one empty paragraph. */
export function isEmptyDoc(doc: DocNode): boolean {
  const blocks = doc.content ?? [];
  return blocks.length === 0 || (blocks.length === 1 && isEmptyParagraph(blocks[0] as DocNode));
}

/**
 * The document with `blocks` put in where insertionIndex says (an empty
 * document's one empty paragraph replaced); null when `under` names no heading.
 */
export function withBlocks(doc: DocNode, blocks: DocNode[], under?: string): DocNode | null {
  if (isEmptyDoc(doc) && under === undefined) return { ...doc, content: blocks };
  const at = insertionIndex(doc, under);
  if (at === null) return null;
  const content = [...(doc.content ?? [])];
  content.splice(at, 0, ...blocks);
  return { ...doc, content };
}

/** Whether the document's blocks from `index` are `blocks` already (an editor that has them). */
export function hasBlocksAt(doc: DocNode, index: number, blocks: DocNode[]): boolean {
  const content = doc.content ?? [];
  return (
    blocks.length > 0 &&
    blocks.every((b, i) => JSON.stringify(content[index + i]) === JSON.stringify(b))
  );
}
