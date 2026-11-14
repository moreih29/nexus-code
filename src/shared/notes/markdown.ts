/**
 * A note's body as Markdown: what `note.md` holds next to `note.json`, and
 * what `nexus note read` prints. The editor's document (ProseMirror JSON, as
 * TipTap gives it) is the note; this is written from it on every save, for
 * agents and anything else that reads text. Assets stay relative to the
 * note's folder (sketches/, materials/, screens/).
 */

/** A node of the editor's document, as TipTap's getJSON() gives it. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** The document as Markdown, ending in one newline (or empty). */
export function docToMarkdown(doc: DocNode | null | undefined): string {
  if (!doc?.content?.length) return "";
  const out = blocks(doc.content, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out ? `${out}\n` : "";
}

/** A link's destination, in angle brackets when it has spaces or brackets. */
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
      return list(node, indent, (_i, item) => (item.attrs?.checked ? "- [x] " : "- [ ] "));
    case "blockquote":
      return prefixLines(blocks(node.content ?? [], ""), `${indent}> `);
    case "codeBlock": {
      const lang = typeof attrs.language === "string" ? attrs.language : "";
      const text = (node.content ?? []).map((t) => t.text ?? "").join("");
      const fence = text.includes("```") ? "~~~" : "```";
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

function list(node: DocNode, indent: string, marker: (i: number, item: DocNode) => string): string {
  return (node.content ?? [])
    .map((item, i) => {
      const m = marker(i, item);
      const inner = (item.content ?? []).map((c) => block(c, "")).join("\n");
      const [first = "", ...rest] = inner.split("\n");
      const pad = " ".repeat(m.length);
      return [`${indent}${m}${first}`, ...rest.map((l) => (l ? `${indent}${pad}${l}` : ""))].join(
        "\n",
      );
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
    if (link) t = `[${t}](${linkTarget(str(link.attrs?.href))})`;
    out += t;
  }
  return out;
}

function codeSpan(t: string): string {
  const ticks = (t.match(/`+/g) ?? []).reduce((a, s) => Math.max(a, s.length), 0);
  const fence = "`".repeat(ticks + 1);
  return ticks ? `${fence} ${t} ${fence}` : `${fence}${t}${fence}`;
}

/** Text with what Markdown would read as markup escaped. */
export function escapeText(t: string): string {
  return t
    .replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`)
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
