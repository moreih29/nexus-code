// An image file the conversation shows where it names it: one Claude sent
// the user, or one a reply puts in its text (![alt](path)). It loads as
// the previews do, from the workspace or a file outside it the tab
// granted, and opens in quick look. One that cannot load shows `fallback`.
// Shown again in the same turn, it is a chip of its name (ImageChip).

import { Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatFiles, useFilePicture } from "../../services/chat/chat-files";
import { imageSrc } from "../../services/chat/image-look";
import { baseName } from "../../services/chat/links";
import { cn } from "../../utils/cn";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { LinkMenu, useChatLinks } from "./chat-links";

export function FileImage({
  path,
  workspaceId,
  alt,
  fallback,
}: {
  /** The image file's absolute path. */
  path: string;
  workspaceId: string;
  alt: string;
  /** What shows when the image cannot: outside what the previews read, or gone. */
  fallback: React.ReactNode;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const file = useWorkspaceFile(workspaceId, path);
  // Another computer's chat reads the picture from there.
  const files = useChatFiles();
  const picture = useFilePicture(files, path);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  if (files) {
    if (picture.failed) return <>{fallback}</>;
    if (!picture.image) {
      return (
        <span
          className="inline-block h-24 w-36 animate-pulse rounded-(--radius-control) bg-muted align-top"
          data-testid="chat-file-image-pending"
        />
      );
    }
  }
  const src = picture.image ? imageSrc(picture.image) : file.kind === "inside" ? file.url : null;
  if (!src || failedFor === src) return <>{fallback}</>;
  const img = (
    <img
      src={src}
      alt={alt}
      onError={() => setFailedFor(src)}
      className="max-h-60 max-w-full rounded-(--radius-control) border border-border object-contain"
    />
  );
  if (!links) return img;
  return (
    <LinkMenu target={path} kind="file">
      <button
        type="button"
        onClick={() => links.openFile(path)}
        title={path}
        aria-label={t("chat.links.look")}
        className="inline-flex max-w-full cursor-zoom-in rounded-(--radius-control) align-top focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="chat-file-image"
      >
        {img}
      </button>
    </LinkMenu>
  );
}

/**
 * An image file its turn showed in full already: its name, which opens it
 * in quick look, as the image does.
 */
export function ImageChip({ path }: { path: string }) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const body = (
    <>
      <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">{baseName(path)}</span>
    </>
  );
  const chip =
    "inline-flex max-w-60 items-center gap-1 rounded-(--radius-control) border border-border px-1.5 py-0.5 align-middle text-app-ui-sm";
  if (!links) {
    return (
      <span className={chip} title={path}>
        {body}
      </span>
    );
  }
  return (
    <LinkMenu target={path} kind="file">
      <button
        type="button"
        onClick={() => links.openFile(path)}
        title={path}
        aria-label={`${t("chat.links.look")}: ${baseName(path)}`}
        className={cn(
          chip,
          "hover:bg-[var(--state-hover-bg)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        data-testid="chat-image-chip"
      >
        {body}
      </button>
    </LinkMenu>
  );
}
