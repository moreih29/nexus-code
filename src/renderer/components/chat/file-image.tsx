import { Image as ImageIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { type LinkedFile, useChatFiles, useFilePicture } from "../../services/chat/chat-files";
import { imageSrc } from "../../services/chat/image-look";
import { baseName } from "../../services/chat/links";
import { cn } from "../../utils/cn";
import { useImageFileSrc } from "../editor/preview/use-image-file-src";
import { useWorkspaceFile } from "../editor/preview/use-workspace-file";
import { useDecodedImageSrc } from "../ui/use-decoded-image-src";
import { LinkMenu, useChatLinks } from "./chat-links";

export function FileImage({
  path,
  workspaceId,
  alt,
  fallback,
  link,
}: {
  path: string;
  workspaceId: string;
  alt: string;
  fallback: React.ReactNode;
  link?: LinkedFile;
}) {
  const { t } = useTranslation();
  const links = useChatLinks();
  const file = useWorkspaceFile(workspaceId, path);
  const files = useChatFiles();
  const picture = useFilePicture(files, path);
  const localSrc = useImageFileSrc(
    workspaceId,
    file.kind === "inside" ? file.relPath : path,
    !files && file.kind === "inside" ? file.url : null,
  );
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const src = useDecodedImageSrc(
    picture.image ? imageSrc(picture.image) : localSrc,
    JSON.stringify([workspaceId, path, files?.access?.scope]),
  );
  if (!src && file.kind === "outside" && !files && links) {
    return <ImageChip path={path} link={link} />;
  }
  if (!src && (files ? !picture.failed : file.kind === "inside")) {
    return (
      <span
        className="inline-block h-24 w-36 animate-pulse rounded-(--radius-control) bg-muted align-top"
        data-testid="chat-file-image-pending"
      />
    );
  }
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
    <LinkMenu target={path} kind="file" link={link}>
      <button
        type="button"
        onClick={() => links.openFile(path, link ? { link } : undefined)}
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

export function ImageChip({ path, link }: { path: string; link?: LinkedFile }) {
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
    <LinkMenu target={path} kind="file" link={link}>
      <button
        type="button"
        onClick={() => links.openFile(path, link ? { link } : undefined)}
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
