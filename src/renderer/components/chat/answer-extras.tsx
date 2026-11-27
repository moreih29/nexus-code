import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  type LinkedFile,
  useChatFiles,
  useFilePicture,
  useLinkRun,
} from "../../services/chat/chat-files";
import { useFoundFiles } from "../../services/chat/file-presence";
import { imageSrc } from "../../services/chat/image-look";
import { grantsOf, linkKey, pathInRoot, useLinksFound } from "../../services/chat/linked-files";
import { baseName, fileKind } from "../../services/chat/links";
import { type AnswerExtras, answerLinks, MAX_ANSWER_FILES } from "../../services/chat/panel";
import { useImageFileSrc } from "../editor/preview/use-image-file-src";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { useDecodedImageSrc } from "../ui/use-decoded-image-src";
import { ChatImage } from "./chat-image";
import { LinkMenu, useChatLinks } from "./chat-links";
import { FileKindIcon } from "./file-kind-icon";

export function AnswerExtrasView({
  extras,
  workspaceId,
  cwd,
  rootPath,
}: {
  extras: AnswerExtras;
  workspaceId: string;
  cwd: string;
  rootPath: string;
}) {
  const grants = grantsOf(useChatFiles());
  const inRun = useLinkRun();
  const viaHost = useMemo(() => {
    const out = new Map<string, LinkedFile>();
    if (!grants) return out;
    for (const [path, link] of Object.entries(answerLinks(extras))) {
      if (pathInRoot(link.href, cwd, rootPath) === null) out.set(path, inRun(link));
    }
    return out;
  }, [grants, extras, cwd, rootPath, inRun]);
  const asked = useMemo(() => (grants ? [...viaHost.values()] : null), [grants, viaHost]);
  const resolved = useLinksFound(asked);
  const lookedUp = useMemo(
    () =>
      [...extras.files, ...Object.values(extras.elsewhere ?? {}).flat()].filter(
        (path) => !viaHost.has(path),
      ),
    [extras, viaHost],
  );
  const found = useFoundFiles(workspaceId, rootPath, lookedUp);
  const { files, links, bare, unread } = useMemo(() => {
    const shown = new Set<string>();
    const links: Record<string, LinkedFile> = {};
    const bare = new Set<string>();
    const unread = new Set<string>();
    for (const path of extras.files) {
      const link = viaHost.get(path);
      if (link) {
        const state = resolved?.get(linkKey(link));
        if (state === undefined || state === null) continue;
        const at = state !== "failed" && "path" in state ? state.path : path;
        if (shown.has(at)) continue;
        shown.add(at);
        links[at] = link;
        if (state === "failed" || !("path" in state) || !state.readable) bare.add(at);
        if (state === "failed") unread.add(at);
        continue;
      }
      const at = found.has(path) ? path : extras.elsewhere?.[path]?.find((p) => found.has(p));
      if (at) shown.add(at);
    }
    return { files: [...shown], links, bare, unread };
  }, [extras, found, viaHost, resolved]);
  const images = useMemo(() => extras.images.map(({ image }) => image), [extras]);
  if (extras.images.length === 0 && files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="chat-answer-extras">
      {extras.images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {extras.images.map(({ file }, i) => (
            <ChatImage
              // biome-ignore lint/suspicious/noArrayIndexKey: a turn's images keep their order
              key={i}
              images={images}
              index={i}
              file={file}
              className="max-h-48 max-w-full rounded-(--radius-control) border border-border object-contain"
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap items-start gap-1.5">
          {files.slice(0, MAX_ANSWER_FILES).map((path, index) => (
            <FileCard
              key={path}
              path={path}
              workspaceId={workspaceId}
              cwd={cwd}
              gallery={files}
              more={index === MAX_ANSWER_FILES - 1 ? files.length - MAX_ANSWER_FILES : 0}
              link={links[path]}
              links={links}
              bare={bare.has(path)}
              unread={unread.has(path)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileCard({
  path,
  workspaceId,
  cwd,
  gallery,
  more = 0,
  link,
  links: galleryLinks,
  bare = false,
  unread = false,
}: {
  path: string;
  workspaceId: string;
  cwd: string;
  gallery?: string[];
  more?: number;
  link?: LinkedFile;
  links?: Readonly<Record<string, LinkedFile>>;
  bare?: boolean;
  unread?: boolean;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const file = useWorkspaceFile(workspaceId, path);
  const isImage = fileKind(path) === "image";
  const files = useChatFiles();
  const picture = useFilePicture(isImage && !bare ? files : null, path);
  const localSrc = useImageFileSrc(
    workspaceId,
    file.kind === "inside" ? file.relPath : path,
    isImage && !files && file.kind === "inside" ? file.url : null,
  );
  const src = useDecodedImageSrc(
    picture.image ? imageSrc(picture.image) : localSrc,
    JSON.stringify([workspaceId, path, files?.access?.scope]),
  );
  const hasThumbnail =
    src !== undefined || (isImage && !bare && (files ? !picture.failed : file.kind === "inside"));
  const folder = folderOf(path, cwd);
  return (
    <LinkMenu target={path} kind="file" link={link}>
      <button
        type="button"
        onClick={() =>
          links?.openFile(
            path,
            gallery || link
              ? {
                  ...(gallery ? { gallery } : {}),
                  ...(link ? { link } : {}),
                  ...(galleryLinks ? { links: galleryLinks } : {}),
                }
              : undefined,
          )
        }
        title={path}
        aria-label={
          more > 0 ? t("chat.more_files", { name: baseName(path), count: more }) : undefined
        }
        className="flex max-w-64 min-w-0 flex-col overflow-hidden rounded-(--radius-control) border border-border text-left hover:bg-[var(--state-hover-bg)]"
        data-testid="chat-file-card"
      >
        {hasThumbnail && (
          <span className="relative">
            {src ? (
              <img src={src} alt="" className="h-28 w-48 bg-muted object-cover" />
            ) : (
              <span
                className="block h-28 w-48 animate-pulse bg-muted"
                data-testid="chat-file-card-image-pending"
              />
            )}
            {more > 0 && (
              <span
                aria-hidden
                className="absolute inset-0 grid place-items-center bg-black/60 text-lg font-semibold text-white"
              >
                +{more}
              </span>
            )}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 px-2 py-1">
          <FileKindIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-app-ui-sm">{baseName(path)}</span>
          {!hasThumbnail && more > 0 && (
            <span aria-hidden className="shrink-0 rounded bg-muted px-1 font-semibold tabular-nums">
              +{more}
            </span>
          )}
          {unread ? (
            <span className="min-w-0 shrink-[4] truncate text-app-micro text-muted-foreground">
              {t("chat.links.load_failed")}
            </span>
          ) : (
            folder && (
              <span className="min-w-0 shrink-[4] truncate text-app-micro text-muted-foreground">
                {folder}
              </span>
            )
          )}
        </span>
      </button>
    </LinkMenu>
  );
}

export function folderOf(path: string, cwd: string): string {
  const slashed = path.replace(/\\/g, "/");
  const dir = slashed.slice(0, Math.max(0, slashed.lastIndexOf("/")));
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (dir === base) return "";
  return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
}
