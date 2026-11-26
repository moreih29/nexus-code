import { AppWindow, Check, ExternalLink, Eye, Link } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isAbsoluteOutsidePath } from "../../../shared/fs/outside-url";
import {
  type ArtifactPage,
  artifactName,
  isHtmlPage,
  titleOfHtml,
} from "../../services/chat/artifact";
import { lookupPath } from "../../services/chat/file-presence";
import { readWorkspaceRange } from "../../services/editor/preview/read-range";
import { peerOf } from "../../services/remote/peer-workspace";
import { cn } from "../../utils/cn";
import { HtmlPreview } from "../editor/preview/html-preview";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { useCopied } from "../ui/copy-button";
import { useChatLinks } from "./chat-links";

const HEAD_BYTES = 8 * 1024;
const TITLE_TRIES = 4;
const TITLE_RETRY_MS = 700;

const THUMB_BYTES = 512 * 1024;

async function readHead(
  workspaceId: string,
  relPath: string,
  bytes = HEAD_BYTES,
): Promise<string | null> {
  const part = await readWorkspaceRange(workspaceId, relPath, 0, bytes).catch(() => null);
  return part ? new TextDecoder().decode(part.bytes) : null;
}

function readPathOf(workspaceId: string, file: string, rootPath: string): string | null {
  if (peerOf(workspaceId)) return file;
  return lookupPath(file, rootPath) ?? (isAbsoluteOutsidePath(file) ? file : null);
}

function useThumbSource(
  workspaceId: string,
  file: string,
  rootPath: string,
  wanted: boolean,
): string | null {
  const [source, setSource] = useState<{ file: string; text: string } | null>(null);
  useEffect(() => {
    const relPath = wanted ? readPathOf(workspaceId, file, rootPath) : null;
    if (relPath === null) return;
    let gone = false;
    void readHead(workspaceId, relPath, THUMB_BYTES).then((text) => {
      if (!gone && text !== null) setSource({ file, text });
    });
    return () => {
      gone = true;
    };
  }, [workspaceId, file, rootPath, wanted]);
  return source?.file === file ? source.text : null;
}

export function useArtifactName(page: ArtifactPage, workspaceId: string, rootPath: string): string {
  const [title, setTitle] = useState<string | null>(null);
  const wanted = page.title === undefined && isHtmlPage(page);
  useEffect(() => {
    setTitle(null);
    if (!wanted) return;
    const relPath = readPathOf(workspaceId, page.file, rootPath);
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

const THUMB_PAGE = { width: 800, height: 500, scale: 0.2 } as const;

function ArtifactThumb({
  page,
  name,
  workspaceId,
  rootPath,
}: {
  page: ArtifactPage;
  name: string;
  workspaceId: string;
  rootPath: string;
}) {
  const file = useWorkspaceFile(workspaceId, page.file);
  const shows = isHtmlPage(page) && file.kind === "inside";
  const source = useThumbSource(workspaceId, page.file, rootPath, shows);
  return (
    <span
      className="relative block shrink-0 overflow-hidden rounded-(--radius-control) border border-border bg-muted"
      style={{
        width: THUMB_PAGE.width * THUMB_PAGE.scale,
        height: THUMB_PAGE.height * THUMB_PAGE.scale,
      }}
    >
      {shows && source !== null ? (
        <HtmlPreview
          source={source}
          workspaceId={workspaceId}
          currentFileAbsPath={page.file}
          thumb={{
            title: name,
            className: "pointer-events-none absolute top-0 left-0 origin-top-left border-0",
            style: {
              width: THUMB_PAGE.width,
              height: THUMB_PAGE.height,
              transform: `scale(${THUMB_PAGE.scale})`,
            },
          }}
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
  const { copied, copy } = useCopied();
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
        <ArtifactThumb page={page} name={name} workspaceId={workspaceId} rootPath={rootPath} />
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
            <CardButton onClick={() => void copy(url)} title={url}>
              {copied ? <Check className="size-3.5" /> : <Link className="size-3.5" />}
              {copied ? t("chat.artifact.copied") : t("chat.artifact.copy")}
            </CardButton>
          )}
        </div>
      </div>
    </div>
  );
}

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
