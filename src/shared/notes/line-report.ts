import { resources } from "../i18n";
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

/** What noteLabel turns into spaces: control and format characters, line and paragraph separators. */
const UNPRINTED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** A JSON string with the characters of tags and templates escaped. */
function quoteLabel(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("{", "\\u007b")
    .replaceAll("}", "\\u007d");
}

/**
 * Quotes user-authored labels in startup instructions and note task prompts.
 * What the agent reads: a JSON string with the characters of tags and
 * templates escaped. People see it through shownNoteText.
 */
export function noteLabel(value: string, fallback = "", max = 120): string {
  const clean = value.replace(UNPRINTED, " ").trim();
  return quoteLabel(Array.from(clean).slice(0, max).join("") || fallback);
}

/** A prompt the app wrote from a note: it names the note to read. */
const NOTE_PROMPT = /`nexus note read [^`\s]+`/;
const LABEL = String.raw`"(?:[^"\\\n]|\\.)*"`;

interface PromptLine {
  /** One whole line. Each piece of the template is a group, in order. */
  pattern: RegExp;
  /** For each group: whether it is a label noteLabel quoted. */
  labels: boolean[];
}

/**
 * The lines of a to-do prompt (noteTaskPrompt) in every language, so a
 * prompt reads the same after the app's language changes.
 */
const PROMPT_LINES: PromptLine[] = Object.values(resources).flatMap(({ notes: { tasks } }) => [
  promptLine(tasks.promptItem),
  promptLine(tasks.promptNote, tasks.promptSection),
]);

function promptLine(template: string, section = ""): PromptLine {
  const labels: boolean[] = [];
  const source = (text: string): string =>
    text
      .split(/(\{\{\w+\}\})/)
      .map((part) => {
        const name = /^\{\{(\w+)\}\}$/.exec(part)?.[1];
        if (name === "section") return `(?:${source(section)})?`;
        if (!part) return "";
        const label = name === "text" || name === "title" || name === "heading";
        labels.push(label);
        if (label) return `(${LABEL})`;
        if (name === "id") return "([^`\\s]+)";
        return `(${part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")})`;
      })
      .join("");
  return { pattern: new RegExp(`^${source(template)}$`), labels };
}

/** A label as noteLabel wrote it, with its own characters; any other quoted text as is. */
function shownLabel(quoted: string): string {
  try {
    const value: unknown = JSON.parse(quoted);
    // noteLabel leaves no control characters and escapes only as quoteLabel does.
    return typeof value === "string" && value.search(UNPRINTED) < 0 && quoteLabel(value) === quoted
      ? `"${value}"`
      : quoted;
  } catch {
    return quoted;
  }
}

function shownLine(line: string): string {
  for (const { pattern, labels } of PROMPT_LINES) {
    const match = pattern.exec(line);
    if (match) {
      return match
        .slice(1)
        .map((part = "", index) => (labels[index] ? shownLabel(part) : part))
        .join("");
    }
  }
  return line;
}

/**
 * A note prompt as people see it (a message bubble, a tab's title): the
 * labels noteLabel quoted in a to-do prompt's lines, with their own
 * characters in place of escapes. The agent is still sent the prompt as
 * written. Other text, quoted or not, is left as the person wrote it.
 */
export function shownNoteText(text: string): string {
  if (!NOTE_PROMPT.test(text)) return text;
  return text.split("\n").map(shownLine).join("\n");
}
