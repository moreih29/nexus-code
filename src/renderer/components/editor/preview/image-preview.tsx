import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { useFileVersion, versionedUrl } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

export interface ImagePreviewProps {
  workspaceId: string;
  filePath: string;
  revision?: number;
  onNaturalSize?: (size: { w: number; h: number }) => void;
  fill?: boolean;
}

export function ImagePreview({
  workspaceId,
  filePath,
  onNaturalSize,
  fill,
  revision,
}: ImagePreviewProps) {
  const { t } = useTranslation();
  const file = useWorkspaceFile(workspaceId, filePath);

  if (file.kind === "no-workspace") {
    return (
      <EmptyState title={t("imagePreview.workspace_not_found")} tone="status" className="min-h-0" />
    );
  }

  if (file.kind === "outside") {
    return (
      <EmptyState title={t("imagePreview.outside_workspace")} tone="status" className="min-h-0" />
    );
  }

  return (
    <ImageCanvas
      url={file.url}
      alt={file.relPath}
      workspaceId={workspaceId}
      relPath={file.relPath}
      onNaturalSize={onNaturalSize}
      fill={fill}
      revision={revision}
    />
  );
}

interface ImageCanvasProps {
  revision?: number;
  url: string;
  alt: string;
  workspaceId: string;
  relPath: string;
  onNaturalSize?: (size: { w: number; h: number }) => void;
  fill?: boolean;
}

const MIN_USER_SCALE = 0.1;
const MAX_USER_SCALE = 16;

const ZOOM_SENSITIVITY = 0.005;

const CANVAS_PADDING_PX = 16;

interface ZoomAnchor {
  ratioX: number;
  ratioY: number;
  cursorX: number;
  cursorY: number;
}

function ImageCanvas({
  url,
  alt,
  workspaceId,
  relPath,
  onNaturalSize,
  fill,
  revision,
}: ImageCanvasProps) {
  const version = useFileVersion(workspaceId, relPath);
  return (
    <ZoomableImage
      src={versionedUrl(url, version, revision)}
      alt={alt}
      onNaturalSize={onNaturalSize}
      fill={fill}
    />
  );
}

export interface ZoomableImageProps {
  src: string;
  alt: string;
  onNaturalSize?: (size: { w: number; h: number }) => void;
  fill?: boolean;
}

export function ZoomableImage({ src, alt, onNaturalSize, fill = false }: ZoomableImageProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const attachContainer = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    setContainerEl(el);
  }, []);
  const imgRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [userScale, setUserScale] = useState(1);
  const [failed, setFailed] = useState(false);

  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);

  const userScaleRef = useRef(userScale);
  useEffect(() => {
    userScaleRef.current = userScale;
  }, [userScale]);

  const [trackedSrc, setTrackedSrc] = useState(src);
  if (trackedSrc !== src) {
    setTrackedSrc(src);
    setFailed(false);
  }

  useEffect(() => {
    if (!naturalSize) return;
    const el = containerEl;
    if (!el) return;
    const recompute = () => {
      const rect = el.getBoundingClientRect();
      const padding = fill ? 0 : CANVAS_PADDING_PX;
      const availW = Math.floor(rect.width) - 2 * padding;
      const availH = Math.floor(rect.height) - 2 * padding;
      if (availW <= 0 || availH <= 0) return;
      setFitScale(Math.min(availW / naturalSize.w, availH / naturalSize.h));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el, { box: "border-box" });
    return () => ro.disconnect();
  }, [naturalSize, containerEl, fill]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only deps
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return;
    const rect = img.getBoundingClientRect();
    const desiredImgLeft = anchor.cursorX - rect.width * anchor.ratioX;
    const desiredImgTop = anchor.cursorY - rect.height * anchor.ratioY;
    container.scrollLeft += rect.left - desiredImgLeft;
    container.scrollTop += rect.top - desiredImgTop;
  }, [userScale, fitScale]);

  useEffect(() => {
    const el = containerEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();

      const img = imgRef.current;
      if (!img) return;

      const current = userScaleRef.current;
      const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      const next = clamp(current * factor, MIN_USER_SCALE, MAX_USER_SCALE);
      if (next === current) return;

      const rect = img.getBoundingClientRect();
      const ratioX = rect.width > 0 ? clamp01((e.clientX - rect.left) / rect.width) : 0.5;
      const ratioY = rect.height > 0 ? clamp01((e.clientY - rect.top) / rect.height) : 0.5;
      zoomAnchorRef.current = { ratioX, ratioY, cursorX: e.clientX, cursorY: e.clientY };
      setUserScale(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerEl]);

  if (failed) {
    return <EmptyState title={t("imagePreview.load_failed")} tone="status" className="min-h-0" />;
  }

  const hasSize = naturalSize !== null;
  const displayW = hasSize ? naturalSize.w * fitScale * userScale : undefined;
  const displayH = hasSize ? naturalSize.h * fitScale * userScale : undefined;

  return (
    <div
      ref={attachContainer}
      className="app-scrollbar flex-1 min-h-0 overflow-auto bg-[var(--surface-backdrop-bg)]"
    >
      <div
        className={cn(
          "min-w-full min-h-full flex items-center-safe justify-center-safe",
          !fill && "p-4",
        )}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          onLoad={(e) => {
            const t = e.currentTarget;
            const size = { w: t.naturalWidth, h: t.naturalHeight };
            setNaturalSize(size);
            onNaturalSize?.(size);
          }}
          onError={() => setFailed(true)}
          style={
            hasSize
              ? {
                  width: `${displayW}px`,
                  height: `${displayH}px`,
                  maxWidth: "none",
                  maxHeight: "none",
                }
              : undefined
          }
          className={hasSize ? undefined : "max-w-full max-h-full object-contain"}
          draggable={false}
        />
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}
