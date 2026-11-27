import { createElement, memo, type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components, type Options, type UrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import { isWindowsPathTarget } from "../../../shared/chat/link-text";
import { REMARK_PLUGINS, writtenHrefOf } from "../../utils/remark-plugins";
import { CopyButton } from "./copy-button";

export type MarkdownNode = {
  tagName?: string;
  value?: string;
  position?: { start?: { line?: number; offset?: number } };
  properties?: Record<string, unknown>;
  children?: unknown[];
};

type RehypePlugins = NonNullable<Options["rehypePlugins"]>;

const HIGHLIGHT: RehypePlugins[number] = [rehypeHighlight, { detect: false, ignoreMissing: true }];
const PLAIN: RehypePlugins = [HIGHLIGHT];
const DOCUMENT: RehypePlugins = [rehypeRaw, rehypeSanitize, rehypeSlug, HIGHLIGHT];
const FILE_DOCUMENT: RehypePlugins = [captureFileTargets, ...DOCUMENT, restoreFileTargets];

type FileTarget = { tag: "a" | "img"; written: string; rendered?: string };

const targetsByFile = new WeakMap<object, Map<number, FileTarget>>();
const targetsByNode = new WeakMap<MarkdownNode, FileTarget>();

export function markdownFileTarget(node: MarkdownNode | undefined) {
  return node && targetsByNode.get(node);
}

function eachFileNode(
  node: MarkdownNode,
  visit: (node: MarkdownNode, tag: "a" | "img", offset: number) => void,
): void {
  const { tagName, position } = node;
  const offset = position?.start?.offset;
  if ((tagName === "a" || tagName === "img") && offset !== undefined) visit(node, tagName, offset);
  for (const child of node.children ?? []) eachFileNode(child as MarkdownNode, visit);
}

function captureFileTargets() {
  return (tree: MarkdownNode, file: object) => {
    const targets = new Map<number, FileTarget>();
    eachFileNode(tree, (node, tag, offset) => {
      const written = writtenHrefOf(node);
      if (written === undefined) return;
      const rendered = node.properties?.[tag === "a" ? "href" : "src"];
      targets.set(offset, {
        tag,
        written,
        rendered:
          isWindowsPathTarget(written) && typeof rendered === "string" ? rendered : undefined,
      });
    });
    targetsByFile.set(file, targets);
  };
}

function restoreFileTargets() {
  return (tree: MarkdownNode, file: object) => {
    const targets = targetsByFile.get(file);
    if (!targets) return;
    eachFileNode(tree, (node, tag, offset) => {
      const target = targets.get(offset);
      if (target?.tag === tag) targetsByNode.set(node, target);
    });
  };
}

const WEB_LINK = /^https?:\/\//i;

export function markdownText(node: MarkdownNode | undefined): string {
  if (!node) return "";
  const kids = Array.isArray(node.children)
    ? node.children.map((child) => markdownText(child as MarkdownNode)).join("")
    : "";
  return (node.value ?? "") + kids;
}

export function ImageName({ alt, title }: { alt?: string; title?: string }) {
  const { t } = useTranslation();
  return (
    <span className="text-muted-foreground" title={title}>
      [{alt || t("markdown.image")}]
    </span>
  );
}

export function MarkdownCodeBlock({
  node,
  children,
  shown,
  ...rest
}: React.HTMLAttributes<HTMLPreElement> & { node?: MarkdownNode; shown?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="md-code-wrap group/code">
      {shown ?? <pre {...rest}>{children}</pre>}
      <CopyButton
        text={() => markdownText(node)}
        label={t("markdown.copy_code")}
        tabIndex={-1}
        className="absolute top-1.5 right-1.5 opacity-0 focus-visible:opacity-100 group-hover/code:opacity-100"
      />
    </div>
  );
}

function WebOnlyLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = typeof href === "string" ? href : "";
  if (!WEB_LINK.test(url)) return <span title={url}>{children}</span>;
  return (
    <a
      href={url}
      title={url}
      onClick={(event) => {
        event.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      }}
    >
      {children}
    </a>
  );
}

function ReadOnlyInput({ type, checked }: { type?: string; checked?: boolean }) {
  return type === "checkbox" ? (
    <input type="checkbox" checked={!!checked} disabled readOnly />
  ) : null;
}

const BASE: Components = {
  pre: MarkdownCodeBlock,
  input: ReadOnlyInput,
};

const WEB_ONLY: Components = {
  a: WebOnlyLink,
  img: ({ alt }) => <ImageName alt={alt} />,
};

type Shown = Components["a"] | Components["img"];

function withoutWrittenHref(tag: "a" | "img", shown: Shown) {
  return function WithoutWrittenHref(props: object) {
    const { "data-written-href": _written, ...rest } = props as Record<string, unknown>;
    if (shown !== undefined && typeof shown !== "string")
      return createElement(shown as never, rest);
    const { node: _node, ...attributes } = rest;
    return createElement(shown ?? tag, attributes);
  };
}

export interface MarkdownBodyProps {
  source: string;
  components?: Components;
  links?: "web-only";
  html?: boolean;
  writtenFileTargets?: boolean;
  urlTransform?: UrlTransform;
}

export const MarkdownBody = memo(function MarkdownBody({
  source,
  components,
  links,
  html = false,
  writtenFileTargets = false,
  urlTransform,
}: MarkdownBodyProps) {
  const merged = useMemo<Components>(() => {
    const given: Components = { ...BASE, ...(links === "web-only" ? WEB_ONLY : {}), ...components };
    return {
      ...given,
      a: withoutWrittenHref("a", given.a) as Components["a"],
      img: withoutWrittenHref("img", given.img) as Components["img"],
    };
  }, [components, links]);
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={html ? (writtenFileTargets ? FILE_DOCUMENT : DOCUMENT) : PLAIN}
      components={merged}
      urlTransform={urlTransform}
    >
      {source}
    </ReactMarkdown>
  );
});
