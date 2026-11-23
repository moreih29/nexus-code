import { clockOf } from "./transcript";

export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function docToMarkdown(doc: DocNode | null | undefined): string {
  if (!doc?.content?.length) return "";
  const out = blocks(doc.content, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out ? `${out}\n` : "";
}

export function linkTarget(href: string): string {
  return /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
}

function blocks(nodes: DocNode[], indent: string): string {
  return nodes.map((n) => block(n, indent)).join("\n\n");
}

function block(node: DocNode, indent: string): string {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "paragraph":
      return prefixLines(inline(node.content), indent);
    case "heading": {
      const level = Math.min(Math.max(Number(attrs.level) || 1, 1), 6);
      return `${indent}${"#".repeat(level)} ${inline(node.content).replace(/\n/g, " ")}`;
    }
    case "bulletList":
      return list(node, indent, () => "- ");
    case "orderedList": {
      const start = Number(attrs.start) || 1;
      return list(node, indent, (i) => `${start + i}. `);
    }
    case "taskList":
      return list(
        node,
        indent,
        (_i, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "),
        taskSource,
      );
    case "blockquote":
      return prefixLines(blocks(node.content ?? [], ""), `${indent}> `);
    case "codeBlock": {
      const lang = typeof attrs.language === "string" ? attrs.language : "";
      const text = (node.content ?? []).map((t) => t.text ?? "").join("");
      const fence = text.includes("```")
        ? "~".repeat(
            (text.match(/~{3,}/g) ?? []).reduce((size, run) => Math.max(size, run.length + 1), 3),
          )
        : "```";
      return prefixLines(`${fence}${lang}\n${text}\n${fence}`, indent);
    }
    case "horizontalRule":
      return `${indent}---`;
    case "sketch": {
      const title = str(attrs.title) || "sketch";
      return `${indent}![${escapeText(title)}](${linkTarget(str(attrs.src))})`;
    }
    case "noteImage":
      return `${indent}![${escapeText(str(attrs.alt))}](${linkTarget(str(attrs.src))})`;
    case "noteFile":
      return `${indent}[${escapeText(str(attrs.name) || str(attrs.src))}](${linkTarget(str(attrs.src))})`;
    default:
      return node.content ? blocks(node.content, indent) : prefixLines(inline([node]), indent);
  }
}

function taskSource(item: DocNode): string {
  const speaker = str(item.attrs?.nexusSpeaker).replace(/\s+/g, " ").trim();
  const at = item.attrs?.nexusAt;
  const time = typeof at === "number" && Number.isFinite(at) && at >= 0 ? clockOf(at) : "";
  const source = [escapeText(speaker), time].filter(Boolean).join(" ");
  return source ? ` — ${source}` : "";
}

function list(
  node: DocNode,
  indent: string,
  marker: (i: number, item: DocNode) => string,
  suffix?: (item: DocNode) => string,
): string {
  return (node.content ?? [])
    .map((item, i) => {
      const m = marker(i, item);
      const inner = (item.content ?? []).map((c) => block(c, "")).join("\n");
      const [first = "", ...rest] = inner.split("\n");
      const pad = " ".repeat(m.length);
      return [
        `${indent}${m}${first}${suffix?.(item) ?? ""}`,
        ...rest.map((l) => (l ? `${indent}${pad}${l}` : "")),
      ].join("\n");
    })
    .join("\n");
}

function inline(nodes: DocNode[] | undefined): string {
  let out = "";
  for (const n of nodes ?? []) {
    if (n.type === "hardBreak") {
      out += "  \n";
      continue;
    }
    if (n.type !== "text") {
      out += inline(n.content);
      continue;
    }
    let t = n.text ?? "";
    const marks = n.marks ?? [];
    const code = marks.some((m) => m.type === "code");
    t = code ? codeSpan(t) : escapeText(t);
    for (const m of marks) {
      if (m.type === "bold") t = `**${t}**`;
      else if (m.type === "italic") t = `*${t}*`;
      else if (m.type === "strike") t = `~~${t}~~`;
    }
    const link = marks.find((m) => m.type === "link");
    if (link) {
      if (out.endsWith("!")) out = `${out.slice(0, -1)}\\!`;
      t = `[${t}](${linkTarget(str(link.attrs?.href))})`;
    }
    out += t;
  }
  return out;
}

function codeSpan(t: string): string {
  const ticks = (t.match(/`+/g) ?? []).reduce((a, s) => Math.max(a, s.length), 0);
  const fence = "`".repeat(ticks + 1);
  return ticks ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

export function escapeText(t: string): string {
  return t
    .replace(/\\(?=[!-/:-@[-`{-~]|\n|$)|[`*_[\]<>]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#+-])(\s)/gm, "$1\\$2$3")
    .replace(/^(\s*\d+)([.)])(\s)/gm, "$1\\$2$3");
}

function prefixLines(text: string, prefix: string): string {
  if (!prefix) return text;
  return text
    .split("\n")
    .map((l) => (l ? `${prefix}${l}` : prefix.trimEnd()))
    .join("\n");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
