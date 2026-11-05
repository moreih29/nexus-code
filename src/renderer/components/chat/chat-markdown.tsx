// Markdown of Claude's replies. Raw HTML is not parsed (react-markdown
// escapes it), so no sanitizing pass is needed. Links go through the same
// classifier as the Markdown preview: files under the workspace open in the
// editor, allowed external schemes in the system browser.

import { Check, Copy } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { openOrRevealEditor } from "../../services/editor";
import { classifyLinkHref } from "../../services/editor/preview/link-router";
import { copyText } from "../../utils/clipboard";

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
  const onLink = useCallback(
    (href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const classified = classifyLinkHref(href, {
        currentFileAbsPath: `${cwd.replace(/\/$/, "")}/.chat`,
        workspaceRootAbsPath: rootPath,
        kind: "link",
      });
      if (classified.kind === "external") {
        window.open(classified.href, "_blank", "noopener,noreferrer");
      } else if (classified.kind === "internal-file") {
        openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
      }
    },
    [cwd, rootPath, workspaceId],
  );

  const components = useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>["components"]>>(
    () => ({
      a({ href, children, ...rest }) {
        const safe = typeof href === "string" ? href : "";
        return (
          <a {...rest} href={safe} title={safe} onClick={(e) => onLink(safe, e)}>
            {children}
          </a>
        );
      },
      pre: CodeBlock,
      // Images in a reply are not loaded from where it names them.
      img({ alt }) {
        return <span className="text-muted-foreground">[{alt || "image"}]</span>;
      },
    }),
    [onLink],
  );

  return (
    <div className="md-preview chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

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
