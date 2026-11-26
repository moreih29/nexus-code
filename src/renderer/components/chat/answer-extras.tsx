import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatFiles, useFilePicture } from "../../services/chat/chat-files";
import { useFoundFiles } from "../../services/chat/file-presence";
import { imageSrc } from "../../services/chat/image-look";
import { baseName, fileKind } from "../../services/chat/links";
import { type AnswerExtras, MAX_ANSWER_FILES } from "../../services/chat/panel";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
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
  const lookedUp = useMemo(
    () => [...extras.files, ...Object.values(extras.elsewhere ?? {}).flat()],
    [extras],
  );
  const found = useFoundFiles(workspaceId, rootPath, lookedUp);
  const files = useMemo(() => {
    const shown = new Set<string>();
    for (const path of extras.files) {
      const at = found.has(path) ? path : extras.elsewhere?.[path]?.find((p) => found.has(p));
      if (at) shown.add(at);
    }
    return [...shown];
  }, [extras, found]);
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
              gallery={
                index === MAX_ANSWER_FILES - 1 && files.length > MAX_ANSWER_FILES
                  ? files
                  : undefined
              }
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
}: {
  path: string;
  workspaceId: string;
  cwd: string;
  gallery?: string[];
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const file = useWorkspaceFile(workspaceId, path);
  const isImage = fileKind(path) === "image";
  const files = useChatFiles();
  const picture = useFilePicture(isImage ? files : null, path);
  const src = !isImage
    ? null
    : picture.image
      ? imageSrc(picture.image)
      : !files && file.kind === "inside"
        ? file.url
        : null;
  const folder = folderOf(path, cwd);
  const more = gallery ? gallery.length - MAX_ANSWER_FILES : 0;
  return (
    <LinkMenu target={path} kind="file">
      <button
        type="button"
        onClick={() => links?.openFile(path, gallery ? { gallery } : undefined)}
        title={path}
        aria-label={
          more > 0 ? t("chat.more_files", { name: baseName(path), count: more }) : undefined
        }
        className="flex max-w-64 min-w-0 flex-col overflow-hidden rounded-(--radius-control) border border-border text-left hover:bg-[var(--state-hover-bg)]"
        data-testid="chat-file-card"
      >
        {src && (
          <span className="relative">
            <img src={src} alt="" className="h-28 w-48 bg-muted object-cover" />
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
          {!src && more > 0 && (
            <span aria-hidden className="shrink-0 rounded bg-muted px-1 font-semibold tabular-nums">
              +{more}
            </span>
          )}
          {folder && (
            <span className="min-w-0 shrink-[4] truncate text-app-micro text-muted-foreground">
              {folder}
            </span>
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
