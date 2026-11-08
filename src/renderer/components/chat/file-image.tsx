// An image file the conversation shows where it names it: one Claude sent
// the user, or one a reply puts in its text (![alt](path)). It loads as
// the previews do, from the workspace or a file outside it the tab
// granted, and opens in quick look. One that cannot load shows `fallback`.

import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  const [failedFor, setFailedFor] = useState<string | null>(null);
  if (file.kind !== "inside" || failedFor === file.url) return <>{fallback}</>;
  const img = (
    <img
      src={file.url}
      alt={alt}
      onError={() => setFailedFor(file.url)}
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
