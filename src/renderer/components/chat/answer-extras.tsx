// Under a turn's last answer: the images its tools gave, and a card for
// each file it wrote new or named. A card opens the file in quick look;
// an image file in the workspace shows itself on its card. A file gets its
// card once it is found to be one.

import { useMemo } from "react";
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
  const found = useFoundFiles(workspaceId, rootPath, extras.files);
  const files = useMemo(
    () => extras.files.filter((path) => found.has(path)).slice(0, MAX_ANSWER_FILES),
    [extras, found],
  );
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
          {files.map((path) => (
            <FileCard key={path} path={path} workspaceId={workspaceId} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A file as a card: its name and folder, an image file its picture too; opens in quick look. */
export function FileCard({
  path,
  workspaceId,
  cwd,
}: {
  path: string;
  workspaceId: string;
  cwd: string;
}) {
  const links = useChatLinks();
  const file = useWorkspaceFile(workspaceId, path);
  const isImage = fileKind(path) === "image";
  // Another computer's chat reads the picture from there.
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
  return (
    <LinkMenu target={path} kind="file">
      <button
        type="button"
        onClick={() => links?.openFile(path)}
        title={path}
        className="flex max-w-64 min-w-0 flex-col overflow-hidden rounded-(--radius-control) border border-border text-left hover:bg-[var(--state-hover-bg)]"
        data-testid="chat-file-card"
      >
        {src && <img src={src} alt="" className="h-28 w-48 bg-muted object-cover" />}
        <span className="flex min-w-0 items-center gap-1.5 px-2 py-1">
          <FileKindIcon path={path} className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-app-ui-sm">{baseName(path)}</span>
          {folder && (
            // The folder gives way before the name does.
            <span className="min-w-0 shrink-[4] truncate text-app-micro text-muted-foreground">
              {folder}
            </span>
          )}
        </span>
      </button>
    </LinkMenu>
  );
}

/**
 * The folder a file is in, from the session's folder when it is under it.
 * Either separator: a Windows path may be written with / or \.
 */
export function folderOf(path: string, cwd: string): string {
  const slashed = path.replace(/\\/g, "/");
  const dir = slashed.slice(0, Math.max(0, slashed.lastIndexOf("/")));
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (dir === base) return "";
  return dir.startsWith(`${base}/`) ? dir.slice(base.length + 1) : dir;
}
