// MediaPreview — plays an audio or video file in the editor panel, in the
// browser's own <audio> or <video> controls, from the file's
// `nexus-workspace://` URL. The protocol serves byte ranges, so a file plays
// as it loads and seeks without being read whole first, for local and SSH
// workspaces alike.
//
// A file changed on disk is loaded again, and playback goes back to where
// it was.

import { type SyntheticEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MediaKind } from "../../../services/editor/preview/media";
import { EmptyState } from "../../ui/empty-state";
import { useFileVersion, versionedUrl } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

/** What a file holds once its metadata loads. */
export interface MediaInfo {
  /** Its length in seconds; not finite for a stream of unknown length. */
  readonly duration: number;
  /** A video's frame size in pixels; 0 for audio. */
  readonly width: number;
  readonly height: number;
}

interface MediaPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
  kind: MediaKind;
  onInfo?: (info: MediaInfo) => void;
}

export function MediaPreview({ workspaceId, filePath, kind, onInfo }: MediaPreviewProps) {
  const { t } = useTranslation();
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") {
    return (
      <EmptyState
        title={
          file.kind === "outside"
            ? t("mediaPreview.outside_workspace")
            : t("imagePreview.workspace_not_found")
        }
        tone="status"
        className="min-h-0"
      />
    );
  }
  return (
    <MediaPlayer
      url={file.url}
      workspaceId={workspaceId}
      relPath={file.relPath}
      kind={kind}
      onInfo={onInfo}
    />
  );
}

interface MediaPlayerProps {
  url: string;
  workspaceId: string;
  relPath: string;
  kind: MediaKind;
  onInfo?: (info: MediaInfo) => void;
}

function MediaPlayer({ url, workspaceId, relPath, kind, onInfo }: MediaPlayerProps) {
  const { t } = useTranslation();
  const src = versionedUrl(url, useFileVersion(workspaceId, relPath));
  const [failed, setFailed] = useState(false);
  // A failure (a format it cannot play, the file missing mid-write) is
  // tried again once the file changes.
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setFailed(false);
  }
  /** Where playback is, as the player last told it. */
  const position = useRef(0);
  /**
   * Where to go back to once a changed file loads. Loading it moves the
   * player to the start first, which `position` must not take.
   */
  const resumeAt = useRef<number | null>(null);
  const loadedSrc = useRef(src);
  useLayoutEffect(() => {
    if (loadedSrc.current === src) return;
    loadedSrc.current = src;
    resumeAt.current = position.current;
  }, [src]);

  if (failed) {
    return <EmptyState title={t("mediaPreview.load_failed")} tone="status" className="min-h-0" />;
  }

  const onLoadedMetadata = (e: SyntheticEvent<HTMLMediaElement>) => {
    const media = e.currentTarget;
    const resume = resumeAt.current;
    resumeAt.current = null;
    if (resume !== null && resume > 0 && resume < media.duration) media.currentTime = resume;
    const video = media instanceof HTMLVideoElement ? media : null;
    onInfo?.({
      duration: media.duration,
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
    });
  };
  const player = {
    src,
    controls: true,
    preload: "metadata",
    onLoadedMetadata,
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) => {
      if (resumeAt.current === null) position.current = e.currentTarget.currentTime;
    },
    onError: () => setFailed(true),
  } as const;

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-[var(--surface-backdrop-bg)]">
      {kind === "video" ? (
        <video {...player} className="max-w-full max-h-full" />
      ) : (
        <audio {...player} className="w-full max-w-xl" />
      )}
    </div>
  );
}
