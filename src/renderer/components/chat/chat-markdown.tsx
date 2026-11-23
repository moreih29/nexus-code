import { Check, Copy } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import { useFoundFiles } from "../../services/chat/file-presence";
import { fileKind, resolveFilePath } from "../../services/chat/links";
import { openOrRevealEditor } from "../../services/editor";
import { classifyLinkHref } from "../../services/editor/preview/link-router";
import { copyText } from "../../utils/clipboard";
import { REMARK_PLUGINS } from "../../utils/remark-plugins";
import { LinkMenu, useChatLinks, useLinkPlaces } from "./chat-links";
import { FileImage, ImageChip } from "./file-image";
import { FileKindIcon } from "./file-kind-icon";

interface ChatMarkdownProps {
  text: string;
  workspaceId: string;
  cwd: string;
  rootPath: string;
  shownEarlier?: ReadonlySet<string>;
}

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  workspaceId,
  cwd,
  rootPath,
  shownEarlier,
}: ChatMarkdownProps) {
  const links = useChatLinks();
  const placesOf = useLinkPlaces();
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
        else if (resolveFilePath(href, cwd)) links.openFile(href);
        else if (classified.kind === "internal-file") links.openFile(classified.absPath);
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
        const link = (icon?: React.ReactNode) => (
          <a {...rest} href={safe} title={safe} onClick={(e) => onLink(safe, e)}>
            {icon}
            {children}
          </a>
        );
        if (kind === "file") {
          const places = placesOf(safe, cwd).map((place) => place.path);
          const path = places[0] ?? safe;
          return (
            <FileLink
              places={places}
              href={safe}
              workspaceId={workspaceId}
              rootPath={rootPath}
              link={link(
                <FileKindIcon path={path} className="mr-0.5 inline size-3.5 align-[-0.15em]" />,
              )}
            >
              {children}
            </FileLink>
          );
        }
        return kind ? (
          <LinkMenu target={safe} href={safe} kind={kind}>
            {link()}
          </LinkMenu>
        ) : (
          link()
        );
      },
      pre: CodeBlock,
      img({ src, alt }) {
        const label = <span className="text-muted-foreground">[{alt || "image"}]</span>;
        const places =
          typeof src === "string" && linkKind(src, cwd) === "file"
            ? placesOf(src, cwd).map((place) => place.path)
            : [];
        const [path] = places;
        if (!path || fileKind(path) !== "image") return label;
        if (shownEarlier?.has(path)) return <ImageChip path={path} />;
        if (places.length === 1) {
          return (
            <FileImage path={path} workspaceId={workspaceId} alt={alt ?? ""} fallback={label} />
          );
        }
        return (
          <PlacedImage
            places={places}
            workspaceId={workspaceId}
            rootPath={rootPath}
            alt={alt ?? ""}
            shownEarlier={shownEarlier}
            fallback={label}
          />
        );
      },
    }),
    [onLink, placesOf, cwd, workspaceId, rootPath, shownEarlier],
  );

  return (
    <div className="md-preview chat-md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
        urlTransform={keepFileUrls}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

function keepFileUrls(url: string): string {
  return /^[A-Za-z]:([\\/]|%5C)/i.test(url) ||
    /^file:\/\//i.test(url) ||
    /^[\w.-]+\.\w+:\d+(:\d+)?$/.test(url)
    ? url
    : defaultUrlTransform(url);
}

function FileLink({
  places,
  href,
  workspaceId,
  rootPath,
  link,
  children,
}: {
  places: readonly string[];
  href: string;
  workspaceId: string;
  rootPath: string;
  link: React.ReactElement;
  children: React.ReactNode;
}) {
  const found = useFoundFiles(workspaceId, rootPath, places);
  const path = places.find((place) => found.has(place));
  if (!path) return <span title={href}>{children}</span>;
  return (
    <LinkMenu target={path} href={href} kind="file">
      {link}
    </LinkMenu>
  );
}

function PlacedImage({
  places,
  workspaceId,
  rootPath,
  alt,
  shownEarlier,
  fallback,
}: {
  places: readonly string[];
  workspaceId: string;
  rootPath: string;
  alt: string;
  shownEarlier: ReadonlySet<string> | undefined;
  fallback: React.ReactNode;
}) {
  const found = useFoundFiles(workspaceId, rootPath, places);
  const path = places.find((place) => found.has(place)) ?? places[0];
  if (shownEarlier?.has(path)) return <ImageChip path={path} />;
  return <FileImage path={path} workspaceId={workspaceId} alt={alt} fallback={fallback} />;
}

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
