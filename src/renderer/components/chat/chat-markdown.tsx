// Markdown of Claude's replies. Raw HTML is not parsed (react-markdown
// escapes it), so no sanitizing pass is needed. Links go through the same
// classifier as the Markdown preview. In a Claude tab a file opens in quick
// look and an address where the tab sends it; elsewhere files under the
// workspace open in the editor, allowed external schemes in the system
// browser.

import { Check, Copy } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { fileKind, resolveFilePath } from "../../services/chat/links";
import { openOrRevealEditor } from "../../services/editor";
import { classifyLinkHref } from "../../services/editor/preview/link-router";
import { copyText } from "../../utils/clipboard";
import { LinkMenu, useChatLinks } from "./chat-links";
import { FileImage } from "./file-image";
import { FileKindIcon } from "./file-kind-icon";

interface ChatMarkdownProps {
  text: string;
  workspaceId: string;
  /** Where the session runs; relative links resolve against it. */
  cwd: string;
  /** The workspace root, outside which file links are not opened. */
  rootPath: string;
}

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  workspaceId,
  cwd,
  rootPath,
}: ChatMarkdownProps) {
  const links = useChatLinks();
  const onLink = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const classified = classifyLinkHref(href, {
        currentFileAbsPath: `${cwd.replace(/\/$/, "")}/.chat`,
        workspaceRootAbsPath: rootPath,
        kind: "link",
      });
      if (links) {
        if (classified.kind === "external") links.openUrl(classified.href);
        else if (classified.kind === "internal-file") links.openFile(classified.absPath);
        else if (classified.kind === "blocked" && resolveFilePath(href, cwd)) links.openFile(href);
        return;
      }
      if (classified.kind === "external") {
        window.open(classified.href, "_blank", "noopener,noreferrer");
      } else if (classified.kind === "internal-file") {
        openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
      }
    },
    [cwd, rootPath, workspaceId, links],
  );

  const components = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>>(
    () => ({
      a({ href, children, ...rest }) {
        const safe = typeof href === "string" ? href : "";
        const kind = linkKind(safe, cwd);
        const link = (
          <a {...rest} href={safe} title={safe} onClick={(e) => onLink(safe, e)}>
            {kind === "file" && (
              <FileKindIcon
                path={resolveFilePath(safe, cwd) ?? safe}
                className="mr-0.5 inline size-3.5 align-[-0.15em]"
              />
            )}
            {children}
          </a>
        );
        return kind ? (
          <LinkMenu
            target={kind === "file" ? (resolveFilePath(safe, cwd) ?? safe) : safe}
            href={safe}
            kind={kind}
          >
            {link}
          </LinkMenu>
        ) : (
          link
        );
      },
      pre: CodeBlock,
      // An image file the reply shows (![alt](path)) shows itself, as the
      // previews load it; a web image is not loaded from where it names it.
      img({ src, alt }) {
        const label = <span className="text-muted-foreground">[{alt || "image"}]</span>;
        const path =
          typeof src === "string" && linkKind(src, cwd) === "file"
            ? resolveFilePath(src, cwd)
            : null;
        if (!path || fileKind(path) !== "image") return label;
        return <FileImage path={path} workspaceId={workspaceId} alt={alt ?? ""} fallback={label} />;
      },
    }),
    [onLink, cwd, workspaceId],
  );

  return (
    <div className="md-preview chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        urlTransform={keepFileUrls}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A link's address as the reply gives it when it names a file, which a
 * click opens in the app: a Windows path (`C:\…`, whose drive reads as a
 * scheme, and whose `\` arrives here as `%5C`), a `file://` URL, or a file
 * name with a line (`a.ts:12`, whose name reads as a scheme too).
 * Anything else as react-markdown allows.
 */
function keepFileUrls(url: string): string {
  return /^[A-Za-z]:([\\/]|%5C)/i.test(url) ||
    /^file:\/\//i.test(url) ||
    /^[\w.-]+\.\w+:\d+(:\d+)?$/.test(url)
    ? url
    : defaultUrlTransform(url);
}

/** Whether a link names a file or a web address; null for anything else. */
function linkKind(href: string, cwd: string): "file" | "url" | null {
  if (/^https?:\/\//i.test(href)) return "url";
  if (href.startsWith("#")) return null;
  return resolveFilePath(href, cwd) ? "file" : null;
}

function CodeBlock({ children, ...rest }: React.HTMLAttributes<HTMLPreElement>) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const onCopy = (event: React.MouseEvent<HTMLButtonElement>) => {
    const pre = event.currentTarget.parentElement?.querySelector("pre");
    copyText(pre?.textContent ?? "");
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="group/code relative">
      <pre {...rest}>{children}</pre>
      <button
        type="button"
        onClick={onCopy}
        title={t("chat.copy")}
        aria-label={t("chat.copy")}
        className="absolute top-1.5 right-1.5 rounded-(--radius-control) p-1 text-muted-foreground opacity-0 group-hover/code:opacity-100 hover:bg-[var(--state-hover-bg)]"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
