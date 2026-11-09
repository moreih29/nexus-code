// A page Claude published as an Artifact, where its call was: a thumbnail
// drawn from the HTML file it published, its name and what it is, with
// buttons to preview the file here, open the page on claude.ai, or copy
// its link. The side panel lists the pages too (ArtifactRow).

import { AppWindow, Check, ExternalLink, Eye, Link } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import {
  type ArtifactPage,
  artifactName,
  isHtmlPage,
  titleOfHtml,
} from "../../services/chat/artifact";
import { lookupPath } from "../../services/chat/file-presence";
import { copyText } from "../../utils/clipboard";
import { cn } from "../../utils/cn";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { useChatLinks } from "./chat-links";

/** How much of a page's file is read for its title. */
const HEAD_BYTES = 8 * 1024;
/** How many times a title that cannot be read yet is tried: the tab grants the file a moment after it names it. */
const TITLE_TRIES = 4;
const TITLE_RETRY_MS = 700;

/** The bytes of a file from its start, as text; null when it cannot be read. */
async function readHead(workspaceId: string, relPath: string): Promise<string | null> {
  const read = await ipcCallResult("fs", "readRange", {
    workspaceId,
    relPath,
    offset: 0,
    length: HEAD_BYTES,
  }).catch(() => null);
  if (!read?.ok || read.value.kind !== "ok") return null;
  const binary = atob(read.value.base64);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/**
 * A page's name: the one its call gave, or its HTML document's title, read
 * from the file in the workspace at `rootPath` or outside it; its file's
 * name till then.
 */
export function useArtifactName(page: ArtifactPage, workspaceId: string, rootPath: string): string {
  const [title, setTitle] = useState<string | null>(null);
  const wanted = page.title === undefined && isHtmlPage(page);
  useEffect(() => {
    setTitle(null);
    if (!wanted) return;
    const relPath =
      lookupPath(page.file, rootPath) ?? (page.file.startsWith("/") ? page.file : null);
    if (relPath === null) return;
    let gone = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const head = await readHead(workspaceId, relPath);
      if (gone) return;
      if (head !== null) setTitle(titleOfHtml(head));
      else if (++tries < TITLE_TRIES) timer = setTimeout(read, TITLE_RETRY_MS);
    };
    void read();
    return () => {
      gone = true;
      clearTimeout(timer);
    };
  }, [wanted, page.file, workspaceId, rootPath]);
  return artifactName(page, title);
}

/** The page's width the thumbnail draws it at, and how small it shows it. */
const THUMB_PAGE = { width: 800, height: 500, scale: 0.2 } as const;

function ArtifactThumb({
  page,
  name,
  workspaceId,
}: {
  page: ArtifactPage;
  name: string;
  workspaceId: string;
}) {
  const file = useWorkspaceFile(workspaceId, page.file);
  return (
    <span
      className="relative block shrink-0 overflow-hidden rounded-(--radius-control) border border-border bg-muted"
      style={{
        width: THUMB_PAGE.width * THUMB_PAGE.scale,
        height: THUMB_PAGE.height * THUMB_PAGE.scale,
      }}
    >
      {isHtmlPage(page) && file.kind === "inside" ? (
        // Drawn, not used: no pointer reaches it, and scripts run in a sandbox of their own.
        <iframe
          src={file.url}
          title={name}
          aria-hidden
          tabIndex={-1}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
          style={{
            width: THUMB_PAGE.width,
            height: THUMB_PAGE.height,
            transform: `scale(${THUMB_PAGE.scale})`,
          }}
          data-testid="chat-artifact-thumb"
        />
      ) : (
        <AppWindow className="absolute inset-0 m-auto size-6 text-muted-foreground" />
      )}
    </span>
  );
}

function CardButton({
  onClick,
  primary = false,
  title,
  children,
}: {
  onClick: () => void;
  primary?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1 rounded-(--radius-control) px-2 py-0.5 text-app-ui-sm",
        primary
          ? "bg-primary text-primary-foreground hover:bg-primary/90"
          : "border border-border text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export function ArtifactCard({
  page,
  workspaceId,
  rootPath,
}: {
  page: ArtifactPage;
  workspaceId: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const name = useArtifactName(page, workspaceId, rootPath);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const { url } = page;
  const preview = () => links?.openFile(page.file);
  return (
    <div
      className="my-1.5 flex max-w-[560px] gap-3 rounded-(--radius-control) border border-border p-2"
      data-tool-use-id={page.toolUseId}
      data-testid="chat-artifact"
    >
      <button
        type="button"
        onClick={preview}
        title={page.file}
        aria-label={t("chat.artifact.preview")}
        className="shrink-0 self-start rounded-(--radius-control) hover:opacity-90"
      >
        <ArtifactThumb page={page} name={name} workspaceId={workspaceId} />
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-app-body font-medium" title={name}>
            {name}
          </span>
        </div>
        {page.description && (
          <p className="line-clamp-2 text-app-ui-sm text-muted-foreground" title={page.description}>
            {page.description}
          </p>
        )}
        <div className="truncate text-app-micro text-muted-foreground">
          {url
            ? page.update
              ? t("chat.artifact.republished")
              : t("chat.artifact.published")
            : t("chat.artifact.local")}
        </div>
        <div className="mt-auto flex flex-wrap gap-1.5 pt-1.5">
          <CardButton primary onClick={preview}>
            <Eye className="size-3.5" />
            {t("chat.artifact.preview")}
          </CardButton>
          {url && (
            <CardButton onClick={() => links?.openUrl(url)} title={url}>
              <ExternalLink className="size-3.5" />
              {t("chat.artifact.open")}
            </CardButton>
          )}
          {url && (
            <CardButton
              onClick={() => {
                copyText(url);
                setCopied(true);
              }}
              title={url}
            >
              {copied ? <Check className="size-3.5" /> : <Link className="size-3.5" />}
              {copied ? t("chat.artifact.copied") : t("chat.artifact.copy")}
            </CardButton>
          )}
        </div>
      </div>
    </div>
  );
}

/** A page in the side panel's list of what the session made: it previews; its page on claude.ai is a click away. */
export function ArtifactRow({
  page,
  workspaceId,
  rootPath,
}: {
  page: ArtifactPage;
  workspaceId: string;
  rootPath: string;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const name = useArtifactName(page, workspaceId, rootPath);
  const { url } = page;
  return (
    <div className="flex min-h-6 min-w-0 items-center gap-1" data-testid="chat-artifact-row">
      <button
        type="button"
        onClick={() => links?.openFile(page.file)}
        title={page.description ?? page.file}
        className="flex min-h-6 min-w-0 flex-1 items-center gap-2 rounded-(--radius-control) px-1 text-left text-app-ui-sm hover:bg-[var(--state-hover-bg)]"
      >
        <AppWindow className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="shrink-0 text-app-micro text-muted-foreground">
          {t("chat.artifact.tag")}
        </span>
      </button>
      {url && (
        <button
          type="button"
          onClick={() => links?.openUrl(url)}
          title={t("chat.artifact.open")}
          aria-label={t("chat.artifact.open")}
          className="shrink-0 rounded-(--radius-control) p-1 text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
        >
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}
