import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface PlainTextOptions {
  listSeparator?: string;
  keepHtml?: boolean;
  keepAutolinks?: boolean;
}

function plainNode(node: Nodes, options: PlainTextOptions): string {
  switch (node.type) {
    case "html":
      return options.keepHtml ? node.value : "";
    case "definition":
      return "";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "link": {
      const label = node.children.map((child) => plainNode(child, options)).join("");
      const autolink = node.url === label || node.url === `mailto:${label}`;
      return autolink && !options.keepAutolinks ? "" : label;
    }
    case "inlineCode":
    case "code":
    case "text":
      return node.value;
    default: {
      if (!("children" in node)) return " ";
      const space = ["root", "list", "listItem", "blockquote", "table", "tableRow"].includes(
        node.type,
      );
      const children = node.children.map((child) => plainNode(child, options));
      if (node.type === "list" && options.listSeparator !== undefined)
        return children.filter((child) => child.trim()).join(options.listSeparator);
      return children.join(space ? " " : "");
    }
  }
}

export function markdownText(text: string, options: PlainTextOptions = {}): string {
  const tree = fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return plainNode(tree, options);
}
