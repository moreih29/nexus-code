import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { Components } from "react-markdown";
import { createLogger } from "../../../../shared/log/renderer";
import { useChatFiles } from "../../../services/chat/chat-files";
import { grantsOf } from "../../../services/chat/linked-files";
import { openOrRevealEditor } from "../../../services/editor";
import {
  classifyLinkHref,
  type LinkClassifyContext,
} from "../../../services/editor/preview/link-router";
import { buildOutsideUrl, buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { peerOf } from "../../../services/remote/peer-workspace";
import { copyText } from "../../../utils/clipboard";
import { useChatLinks } from "../../chat/chat-links";
import {
  ImageName,
  MarkdownBody,
  MarkdownCodeBlock,
  type MarkdownNode,
  markdownText,
} from "../../ui/markdown-body";
import { capPreviewSource, getPreviewTruncatedMessage } from "./constants";
import { MermaidDiagram } from "./mermaid-diagram";

const log = createLogger("markdown-preview");

interface MarkdownPreviewProps {
  source: string;
  workspaceId: string;
  currentFileAbsPath: string;
  workspaceRootAbsPath: string;
  onToggleTask?: (modelLine: number) => void;
  images?: ReadonlyMap<string, string>;
}

interface PreviewContextValue {
  onToggleTask?: (modelLine: number) => void;
  frontmatterLineOffset: number;
  onCopyAnchor: (id: string) => void;
  collapsed: ReadonlySet<string>;
  toggleCollapse: (id: string) => void;
}

const PreviewContext = createContext<PreviewContextValue | null>(null);

const TaskLineContext = createContext<number | null>(null);

export function MarkdownPreview({
  source,
  workspaceId,
  currentFileAbsPath,
  workspaceRootAbsPath,
  onToggleTask,
  images,
}: MarkdownPreviewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const body = useMemo(() => stripFrontmatter(source), [source]);
  const frontmatterLineOffset = useMemo(
    () => (body === source ? 0 : countNewlines(source.slice(0, source.length - body.length))),
    [source, body],
  );
  const { text, truncated } = capPreviewSource(body);

  const linkCtx: LinkClassifyContext = useMemo(
    () => ({ currentFileAbsPath, workspaceRootAbsPath, kind: "link" }),
    [currentFileAbsPath, workspaceRootAbsPath],
  );
  const imageCtx: LinkClassifyContext = useMemo(
    () => ({ currentFileAbsPath, workspaceRootAbsPath, kind: "image" }),
    [currentFileAbsPath, workspaceRootAbsPath],
  );

  const scrollToAnchor = useCallback((id: string) => {
    const container = containerRef.current;
    if (!container) return;
    const target =
      container.querySelector(`[id="${cssEscape(id)}"]`) ??
      container.querySelector(`[id="${cssEscape(`user-content-${id}`)}"]`) ??
      container.querySelector(`[id="${cssEscape(id.toLowerCase())}"]`);
    if (target && target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: "auto", block: "start" });
    }
  }, []);

  const chatLinks = useChatLinks();
  const viaHost = grantsOf(useChatFiles()) && peerOf(workspaceId) !== null;
  const onLinkClick = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const classified = classifyLinkHref(href, linkCtx);
      if (
        viaHost &&
        chatLinks &&
        classified.kind === "blocked" &&
        !href.startsWith("#") &&
        !/^[a-z][a-z0-9+.-]+:/i.test(href)
      ) {
        chatLinks.openFile(href, {
          link: { href, source: { kind: "file", parent: currentFileAbsPath } },
        });
        return;
      }
      switch (classified.kind) {
        case "anchor":
          scrollToAnchor(classified.id);
          return;
        case "external":
          window.open(classified.href, "_blank", "noopener,noreferrer");
          return;
        case "internal-file":
          if (peerOf(workspaceId)) chatLinks?.openFile(classified.absPath);
          else openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
          return;
        case "blocked":
          log.warn(`blocked link click: ${classified.reason}`);
          return;
      }
    },
    [linkCtx, scrollToAnchor, workspaceId, chatLinks, viaHost, currentFileAbsPath],
  );

  const onCopyAnchor = useCallback((id: string) => {
    copyText(`#${id}`);
  }, []);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-apply folds after the rendered DOM changes
  useLayoutEffect(() => {
    const content = containerRef.current?.querySelector<HTMLElement>(".md-content");
    if (!content) return;
    const children = Array.from(content.children) as HTMLElement[];
    for (const el of children) el.removeAttribute("data-md-hidden");
    for (let i = 0; i < children.length; i++) {
      const level = headingLevel(children[i]);
      const id = children[i].id;
      if (level === null || !id || !collapsed.has(id)) continue;
      for (let j = i + 1; j < children.length; j++) {
        const siblingLevel = headingLevel(children[j]);
        if (siblingLevel !== null && siblingLevel <= level) break;
        children[j].setAttribute("data-md-hidden", "");
      }
    }
  }, [text, collapsed, frontmatterLineOffset]);

  const previewCtx = useMemo<PreviewContextValue>(
    () => ({ onToggleTask, frontmatterLineOffset, onCopyAnchor, collapsed, toggleCollapse }),
    [onToggleTask, frontmatterLineOffset, onCopyAnchor, collapsed, toggleCollapse],
  );

  const components = useMemo<Components>(
    () => ({
      a({ href, children, ...rest }) {
        const safeHref = typeof href === "string" ? href : "";
        return (
          <a {...rest} href={safeHref} onClick={(e) => onLinkClick(safeHref, e)}>
            {children}
          </a>
        );
      },
      img({ src, alt, ...rest }) {
        const rawSrc = typeof src === "string" ? src : "";
        const resolved = images?.get(rawSrc) ?? resolveImageSrc(rawSrc, workspaceId, imageCtx);
        if (resolved === null) {
          return <ImageName alt={alt} title={t("markdown.image_not_loaded", { src: rawSrc })} />;
        }
        return <img {...rest} src={resolved} alt={alt ?? ""} />;
      },
      li: MdListItem,
      input: MdInput,
      pre: MdPre,
      h1: MdHeading,
      h2: MdHeading,
      h3: MdHeading,
      h4: MdHeading,
      h5: MdHeading,
      h6: MdHeading,
    }),
    [imageCtx, images, onLinkClick, workspaceId, t],
  );

  return (
    <div ref={containerRef} className="md-preview h-full min-h-0 overflow-auto">
      {truncated && (
        <div
          role="status"
          className="px-3 py-1 text-app-ui-sm text-[var(--state-warning-fg)] bg-[var(--state-warning-bg)] border-b border-[var(--state-warning-border)]"
        >
          {getPreviewTruncatedMessage()}
        </div>
      )}
      <PreviewContext.Provider value={previewCtx}>
        <div className="md-content mx-auto max-w-[72ch] px-6 py-4 text-[var(--surface-island-fg)]">
          <MarkdownBody source={text} components={components} html />
        </div>
      </PreviewContext.Provider>
    </div>
  );
}

type RmNode = MarkdownNode;

function MdListItem({ node, children, ...rest }: { node?: RmNode; children?: React.ReactNode }) {
  const ctx = useContext(PreviewContext);
  const className = (node?.properties?.className as string[] | undefined) ?? [];
  const isTask = Array.isArray(className) && className.includes("task-list-item");
  const astLine = node?.position?.start?.line;

  if (isTask && ctx?.onToggleTask && typeof astLine === "number") {
    const modelLine = astLine + ctx.frontmatterLineOffset;
    return (
      <li {...rest}>
        <TaskLineContext.Provider value={modelLine}>{children}</TaskLineContext.Provider>
      </li>
    );
  }
  return <li {...rest}>{children}</li>;
}

function MdInput({
  type,
  checked,
  node: _node,
  disabled: _disabled,
  ...rest
}: {
  type?: string;
  checked?: boolean;
  disabled?: boolean;
  node?: RmNode;
}) {
  const ctx = useContext(PreviewContext);
  const modelLine = useContext(TaskLineContext);

  if (type === "checkbox" && ctx?.onToggleTask && modelLine != null) {
    return (
      <input
        {...rest}
        type="checkbox"
        className="md-task-checkbox"
        checked={Boolean(checked)}
        onChange={() => ctx.onToggleTask?.(modelLine)}
      />
    );
  }
  return <input {...rest} type={type} checked={Boolean(checked)} disabled readOnly />;
}

function MdPre({ node, ...rest }: React.HTMLAttributes<HTMLPreElement> & { node?: RmNode }) {
  return (
    <MarkdownCodeBlock
      node={node}
      shown={isMermaid(node) ? <MermaidDiagram code={markdownText(node)} /> : undefined}
      {...rest}
    />
  );
}

function isMermaid(pre: RmNode | undefined): boolean {
  const code = pre?.children?.[0] as RmNode | undefined;
  const className = code?.tagName === "code" ? code.properties?.className : undefined;
  return Array.isArray(className) && className.includes("language-mermaid");
}

function MdHeading({
  node,
  children,
  id,
  ...rest
}: {
  node?: RmNode;
  children?: React.ReactNode;
  id?: string;
}) {
  const { t } = useTranslation();
  const ctx = useContext(PreviewContext);
  const Tag = (node?.tagName ?? "h2") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  const headingId = typeof id === "string" && id.length > 0 ? id : undefined;
  const isCollapsed = headingId ? ctx?.collapsed.has(headingId) : false;

  return (
    <Tag
      id={headingId}
      className="md-heading"
      data-collapsed={isCollapsed ? "" : undefined}
      {...rest}
    >
      {headingId && (
        <button
          type="button"
          className="md-heading-fold"
          tabIndex={-1}
          aria-label={isCollapsed ? t("markdown.expand_section") : t("markdown.collapse_section")}
          aria-expanded={!isCollapsed}
          onClick={() => ctx?.toggleCollapse(headingId)}
        >
          ▾
        </button>
      )}
      <span className="md-heading-text">{children}</span>
      {headingId && (
        <button
          type="button"
          className="md-heading-anchor"
          tabIndex={-1}
          aria-label={t("markdown.copy_link")}
          onClick={() => ctx?.onCopyAnchor(headingId)}
        >
          #
        </button>
      )}
    </Tag>
  );
}

function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

function headingLevel(el: Element): number | null {
  const m = /^H([1-6])$/.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

export function stripFrontmatter(source: string): string {
  const FRONTMATTER_RE = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/u;
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return source;

  const inner = match[0].replace(/^\uFEFF?---\r?\n/u, "").replace(/\r?\n---(?:\r?\n|$)/u, "");
  const HAS_YAML_KEY = /^[\p{L}_][\p{L}\p{N}_-]*\s*:/mu;
  if (!HAS_YAML_KEY.test(inner)) return source;

  return source.replace(FRONTMATTER_RE, "");
}

function resolveImageSrc(
  rawSrc: string,
  workspaceId: string,
  ctx: LinkClassifyContext,
): string | null {
  if (!rawSrc) return null;
  const classified = classifyLinkHref(rawSrc, ctx);
  switch (classified.kind) {
    case "external":
      return classified.href;
    case "internal-file":
      return peerOf(workspaceId)
        ? buildOutsideUrl(workspaceId, classified.absPath)
        : buildWorkspaceUrl(workspaceId, classified.relPath);
    case "anchor":
    case "blocked":
      return null;
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
