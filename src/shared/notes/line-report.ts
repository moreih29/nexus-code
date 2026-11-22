import type { NoteLinkResult } from "./links";
import type { DocNode } from "./markdown";

export interface LineReport {
  linkId: string;
  check: boolean;
  result: NoteLinkResult;
}

export function isTaskLink(link: { kind: string }): boolean {
  return link.kind === "line" || link.kind === "task";
}

export function prLabel(pr: NonNullable<NoteLinkResult["pr"]>): string {
  return pr.number ? `PR #${pr.number}` : "PR";
}

/** Finds exactly one task item, so a duplicated id cannot redirect a report. */
export function linkedTask(doc: DocNode, linkId: string): DocNode | undefined {
  let match: DocNode | undefined;
  function visit(node: DocNode): boolean {
    if (node.type === "taskItem" && node.attrs?.nexusLink === linkId) {
      if (match) return false;
      match = node;
    }
    return (node.content ?? []).every(visit);
  }
  return visit(doc) ? match : undefined;
}

export function reportParagraph({ linkId, result }: LineReport): DocNode {
  const content: DocNode[] = [];
  if (result.summary) {
    content.push({ type: "text", text: result.summary + (result.pr ? " · " : "") });
  }
  if (result.pr) {
    content.push({
      type: "text",
      text: prLabel(result.pr),
      marks: [{ type: "link", attrs: { href: result.pr.url } }],
    });
  }
  return {
    type: "paragraph",
    attrs: { nexusOrigin: `report:${linkId}` },
    ...(content.length ? { content } : {}),
  };
}

export function isReportParagraph(node: Pick<DocNode, "type" | "attrs">, linkId: string): boolean {
  return node.type === "paragraph" && node.attrs?.nexusOrigin === `report:${linkId}`;
}

export function withLineReport(doc: DocNode, report: LineReport): DocNode {
  const task = linkedTask(doc, report.linkId);
  if (!task) return doc;
  const paragraph = reportParagraph(report);
  function visit(node: DocNode): DocNode {
    if (node === task) {
      const content = (node.content ?? []).slice();
      const index = content.findIndex((child) => isReportParagraph(child, report.linkId));
      if (index < 0) content.splice(1, 0, paragraph);
      else content[index] = paragraph;
      return {
        ...node,
        attrs: { ...node.attrs, ...(report.check ? { checked: true } : {}) },
        content,
      };
    }
    if (!node.content) return node;
    const content = node.content.map(visit);
    return content.some((child, index) => child !== node.content?.[index])
      ? { ...node, content }
      : node;
  }
  return visit(doc);
}

export function taskSource(attrs: DocNode["attrs"]): { speaker: string; at?: number } {
  const value = attrs?.nexusSpeaker;
  const speaker = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  const at = attrs?.nexusAt;
  return { speaker, at: typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : undefined };
}

export function taskText(node: DocNode | undefined): string {
  function text(block: DocNode): string {
    if (block.type === "hardBreak") return " ";
    return block.text ?? (block.content ?? []).map(text).join("");
  }
  const first = node?.content?.[0];
  return first ? text(first) : "";
}

/** Quotes user-authored labels in startup instructions and note task prompts. */
export function noteLabel(value: string, fallback = "", max = 120): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  return JSON.stringify(Array.from(clean).slice(0, max).join("") || fallback)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("{", "\\u007b")
    .replaceAll("}", "\\u007d");
}
