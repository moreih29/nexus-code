import { markdownToBlocks } from "./from-markdown";
import { withBlocks } from "./insert";
import type { DocNode } from "./markdown";

export function safeNoteUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return;
  const url = URL.parse(value);
  if (!url?.hostname) return;
  return url.href.replace(/[()<>'"\\]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
}

function sanitizeBlock(node: DocNode): DocNode[] {
  const { attrs, marks, content } = node;
  const language = attrs?.language;
  const text = node.text?.replace(/\p{Cf}/gu, "");
  if (node.type === "text" && !text) return [];
  return [
    {
      ...node,
      ...(text !== undefined && { text }),
      ...(node.type === "codeBlock" && typeof language === "string" && !/^[\w.+#-]+$/.test(language)
        ? { attrs: { language: null } }
        : {}),
      ...(marks && {
        marks: marks.flatMap((mark) => {
          if (mark.type !== "link") return [mark];
          const href = safeNoteUrl(mark.attrs?.href);
          return href ? [{ type: "link", attrs: { href } }] : [];
        }),
      }),
      ...(content && { content: content.flatMap(sanitizeBlock) }),
    },
  ];
}

export function answerCardBlocks(markdown: string, imageAlt: string): DocNode[] {
  return markdownToBlocks(markdown, imageAlt).flatMap(sanitizeBlock);
}

export function answerCard(linkId: string, content: DocNode[]): DocNode {
  return { type: "blockquote", attrs: { nexusLink: linkId }, content };
}

export function hasAnswerCard(doc: DocNode, linkId: string): boolean {
  return (
    (doc.type === "blockquote" && doc.attrs?.nexusLink === linkId) ||
    (doc.content?.some((node) => hasAnswerCard(node, linkId)) ?? false)
  );
}

export function withAnswerCard(doc: DocNode, card: DocNode): DocNode {
  const linkId = card.attrs?.nexusLink;
  if (typeof linkId !== "string" || hasAnswerCard(doc, linkId)) return doc;
  return withBlocks(doc, [card]) ?? doc;
}
