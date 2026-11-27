import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  commonMarkDestination,
  definitionTargetAt,
  inlineTargetAt,
  isWindowsPathTarget,
  linkDestination,
  linkHrefOf,
} from "../../shared/chat/link-text";

export const WRITTEN_HREF = "dataWrittenHref";

interface Offsets {
  start?: { offset?: number };
  end?: { offset?: number };
}

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  position?: Offsets;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
}

const DEFINITION_LABEL = /^\[(?:[^\][\\\n]|\\.)+\]:/;

function span(node: MarkdownNode): [number, number] | null {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  return start === undefined || end === undefined ? null : [start, end];
}

function inlineWritten(markdown: string, node: MarkdownNode): string | null {
  const at = span(node);
  if (!at || node.url === undefined) return null;
  const [start, end] = at;
  const opener = node.type === "image" ? "![" : "[";
  if (!markdown.startsWith(opener, start)) return null;
  const label = node.children?.at(-1)?.position?.end?.offset;
  const starts: number[] = [];
  if (label !== undefined && markdown.startsWith("](", label)) starts.push(label + 2);
  else {
    for (
      let i = markdown.indexOf("](", start);
      i !== -1 && i < end;
      i = markdown.indexOf("](", i + 1)
    ) {
      starts.push(i + 2);
    }
  }
  for (const from of starts) {
    const target = inlineTargetAt(markdown, from);
    if (target && target.end === end && commonMarkDestination(target.written) === node.url) {
      return target.written;
    }
  }
  return null;
}

function definitionWritten(markdown: string, node: MarkdownNode): string | null {
  const at = span(node);
  if (!at || node.url === undefined) return null;
  const [start, end] = at;
  const label = DEFINITION_LABEL.exec(markdown.slice(start, end));
  if (!label) return null;
  const target = definitionTargetAt(markdown, start + label[0].length);
  return target && target.end <= end && commonMarkDestination(target.written) === node.url
    ? target.written
    : null;
}

function eachNode(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) eachNode(child, visit);
}

function carriedHref(written: string): string | null {
  if (isWindowsPathTarget(written)) return linkHrefOf(written);
  const target = commonMarkDestination(written);
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(target) && !/^file:\/\//i.test(target)) return null;
  return linkHrefOf(written);
}

function carryHref(node: MarkdownNode, href: string | null): void {
  if (href === null) return;
  node.data = {
    ...node.data,
    hProperties: { ...node.data?.hProperties, [WRITTEN_HREF]: href },
  };
}

function carryWritten(node: MarkdownNode, written: string): void {
  carryHref(node, carriedHref(written));
}

function keepWrittenTargets(markdown: string, tree: MarkdownNode): void {
  const definitions = new Map<string, string | null>();
  eachNode(tree, (node) => {
    if (node.type !== "definition" || node.identifier === undefined) return;
    const written = definitionWritten(markdown, node);
    if (written === null) return;
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, carriedHref(written));
    if (isWindowsPathTarget(written)) node.url = linkDestination(written);
  });
  eachNode(tree, (node) => {
    if (node.type === "link" || node.type === "image") {
      const written = inlineWritten(markdown, node);
      if (written === null) return;
      if (isWindowsPathTarget(written)) node.url = linkDestination(written);
      carryWritten(node, written);
    } else if (node.type === "linkReference" || node.type === "imageReference") {
      const href = node.identifier === undefined ? undefined : definitions.get(node.identifier);
      if (href !== undefined) carryHref(node, href);
    }
  });
}

export function remarkWrittenLinks() {
  return (tree: MarkdownNode, file: { value?: unknown }) => {
    if (typeof file.value === "string") keepWrittenTargets(file.value, tree);
  };
}

export function writtenHrefOf(node: unknown): string | undefined {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const href = properties?.[WRITTEN_HREF];
  return typeof href === "string" ? href : undefined;
}

export const REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [
  [remarkGfm, { singleTilde: false }],
  remarkWrittenLinks,
];
