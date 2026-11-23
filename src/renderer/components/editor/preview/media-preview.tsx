import { type SyntheticEvent, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBannerDismissal } from "../../../hooks/use-banner-dismissal";
import {
  changePending,
  isPlaying,
  mediaResume,
  nextShownVersion,
} from "../../../services/editor/preview/file-refresh";
import type { MediaKind } from "../../../services/editor/preview/media";
import { Banner } from "../../ui/banner";
import { EmptyState } from "../../ui/empty-state";
import { useFileVersion, versionedUrl } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

export interface MediaInfo {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
}

interface MediaPreviewProps {
  workspaceId: string;
  tabId?: string | undefined;
  filePath: string;
  kind: MediaKind;
  onInfo?: (info: MediaInfo) => void;
}

export function MediaPreview({ workspaceId, tabId, filePath, kind, onInfo }: MediaPreviewProps) {
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
      tabId={tabId}
      relPath={file.relPath}
      kind={kind}
      onInfo={onInfo}
    />
  );
}

interface MediaPlayerProps {
  url: string;
  workspaceId: string;
  tabId?: string | undefined;
  relPath: string;
  kind: MediaKind;
  onInfo?: (info: MediaInfo) => void;
}

function MediaPlayer({ url, workspaceId, tabId, relPath, kind, onInfo }: MediaPlayerProps) {
  const { t } = useTranslation();
  const latest = useFileVersion(workspaceId, relPath);
  const [playing, setPlaying] = useState(false);
  const [shown, setShown] = useState(latest);
  const resumePlay = useRef(false);
  const next = nextShownVersion(shown, latest, playing);
  if (next !== shown) setShown(next);
  const pending = changePending(shown, latest);
  const notice = useBannerDismissal(["media-changed", workspaceId, tabId, relPath], [latest]);
  const src = versionedUrl(url, shown);
  const [failed, setFailed] = useState(false);
  const [trackedSrc, setTrackedSrc] = useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setFailed(false);
  }
  const position = useRef(0);
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
    const wasPlaying = resumePlay.current;
    resumePlay.current = false;
    if (resume !== null) {
      const again = mediaResume(resume, media.duration, wasPlaying);
      if (again.at !== null) media.currentTime = again.at;
      if (again.play) void media.play().catch(() => {});
    }
    const video = media instanceof HTMLVideoElement ? media : null;
    onInfo?.({
      duration: media.duration,
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
    });
  };
  const track = (e: SyntheticEvent<HTMLMediaElement>) => setPlaying(isPlaying(e.currentTarget));
  const player = {
    src,
    controls: true,
    preload: "metadata",
    onLoadedMetadata,
    onTimeUpdate: (e: SyntheticEvent<HTMLMediaElement>) => {
      if (resumeAt.current === null) position.current = e.currentTarget.currentTime;
    },
    onPlay: track,
    onPlaying: track,
    onPause: track,
    onEnded: track,
    onError: () => setFailed(true),
  } as const;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {pending && !notice.dismissed && (
        <Banner
          display="bar"
          variant="info"
          role="status"
          message={t("mediaPreview.file_changed")}
          dismiss={notice.dismiss}
          actions={[
            {
              label: t("mediaPreview.reload"),
              onAction: () => {
                resumePlay.current = playing;
                setPlaying(false);
                setShown(latest);
              },
            },
          ]}
        />
      )}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-[var(--surface-backdrop-bg)]">
        {kind === "video" ? (
          <video {...player} className="max-w-full max-h-full" />
        ) : (
          <audio {...player} className="w-full max-w-xl" />
        )}
      </div>
    </div>
  );
}
