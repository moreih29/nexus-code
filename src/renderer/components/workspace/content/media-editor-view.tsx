// The editor surface of an audio or video file: the breadcrumb toolbar the
// other editors have, its right slot showing the file's length (and a
// video's frame size), and the player below. Media files are not editable.

import { useState } from "react";
import { type MediaKind, mediaDuration } from "../../../services/editor/preview/media";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { type MediaInfo, MediaPreview } from "../../editor/preview/media-preview";
import { EditorBreadcrumbs } from "./editor-breadcrumbs";

interface MediaEditorViewProps {
  filePath: string;
  workspaceId: string;
  kind: MediaKind;
}

export function MediaEditorView({ filePath, workspaceId, kind }: MediaEditorViewProps) {
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const label = info && mediaLabel(info);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-[var(--surface-island-border)]">
        <EditorBreadcrumbs filePath={filePath} workspaceRootAbsPath={workspaceRootAbsPath} />
        {label && (
          <span className="text-app-ui-sm tabular-nums text-muted-foreground px-1 select-none">
            {label}
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 flex">
        <MediaPreview workspaceId={workspaceId} filePath={filePath} kind={kind} onInfo={setInfo} />
      </div>
    </div>
  );
}

/** "1920 × 1080 · 1:23" for a video, "1:23" for audio. */
function mediaLabel(info: MediaInfo): string {
  const parts: string[] = [];
  if (info.width > 0 && info.height > 0) parts.push(`${info.width} × ${info.height}`);
  if (Number.isFinite(info.duration)) parts.push(mediaDuration(info.duration));
  return parts.join(" · ");
}
