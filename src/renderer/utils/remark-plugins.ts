import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  isWindowsPathTarget,
  linkDestination,
  writtenDestinationIn,
} from "../../shared/chat/link-text";

interface MarkdownNode {
  type: string;
  url?: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: MarkdownNode[];
}

const LINKED = new Set(["link", "image", "definition"]);

function keepWindowsTargets(markdown: string, node: MarkdownNode): void {
  if (LINKED.has(node.type)) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start !== undefined && end !== undefined) {
      const written = writtenDestinationIn(markdown.slice(start, end));
      if (written !== null && isWindowsPathTarget(written)) node.url = linkDestination(written);
    }
  }
  for (const child of node.children ?? []) keepWindowsTargets(markdown, child);
}

export function remarkWindowsLinks() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    if (typeof file.value === "string") keepWindowsTargets(file.value, tree);
  };
}

export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkWindowsLinks,
];
