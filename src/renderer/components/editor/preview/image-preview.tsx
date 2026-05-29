// ImagePreview — renders raster image files (png/jpg/gif/webp/bmp/ico/avif)
// in the editor panel via the `nexus-workspace://<workspaceId>/<relPath>`
// custom protocol registered in main.
//
// WHY NOT MONACO
//   Raster images are binary; routing them through the shared TextModel
//   cache only produces the "Cannot display binary file." rejection. The
//   image viewer bypasses model acquisition entirely and renders an
//   `<img>` element directly. EditorView keys on `filePath`, so this
//   branch is taken on mount for image tabs and never swaps in/out of
//   the same instance.
//
// REMOTE WORKSPACES
//   The `nexus-workspace://` protocol now routes SSH workspaces through
//   the agent's `fs.readBinary` method (base64-over-NDJSON), so the same
//   URL transparently fetches local or remote bytes. The renderer no
//   longer needs to branch on workspace.location.kind.
//
// ZOOM (cmd+wheel)
//   The canvas tracks two independent factors:
//     - fitScale  — `min(containerW/naturalW, containerH/naturalH)`, the
//                   classic object-contain ratio. Recomputed whenever the
//                   container or natural size changes (ResizeObserver),
//                   so panel splits / window resizes keep the image
//                   visually fitted by default.
//     - userScale — the user's accumulated zoom gesture. 1 = fit, range
//                   [0.1, 16]. Preserved across container resizes so the
//                   relative zoom level survives layout changes.
//   Display size = naturalSize × fitScale × userScale.
//   When the result exceeds the container, the outer div's overflow-auto
//   produces horizontal/vertical scrollbars. When smaller, flex centering
//   on the inner wrapper keeps the image in the middle.
//
//   Cursor-anchored zoom: at wheel time we snapshot the cursor's position
//   relative to the image as ratios in [0,1]; a useLayoutEffect then
//   adjusts scrollLeft/scrollTop after the new dimensions commit so the
//   same image point stays under the cursor (single repaint, no flash).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildWorkspaceUrl } from "../../../services/editor/preview/workspace-url";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { relPath } from "../../../utils/path";
import { EmptyState } from "../../ui/empty-state";

export interface ImagePreviewProps {
  /** Workspace owning the file — used to scope the custom-protocol URL. */
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
  /**
   * Fires once after the image finishes decoding, reporting its intrinsic
   * pixel dimensions. Used by ImageEditorView to render a resolution chip
   * in the toolbar without duplicating the image fetch.
   */
  onNaturalSize?: (size: { w: number; h: number }) => void;
}

export function ImagePreview({ workspaceId, filePath, onNaturalSize }: ImagePreviewProps) {
  const { t } = useTranslation();
  const workspace = useWorkspacesStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  // Defensive: workspace should always exist when an editor tab is open,
  // but guard against teardown races where the tab survives past the
  // workspace removal for one render.
  if (!workspace) {
    return <EmptyState title={t("imagePreview.workspace_not_found")} tone="status" className="min-h-0" />;
  }

  // rootPath is location-shaped: WorkspaceLocation discriminates on `kind`
  // with rootPath (local) / remotePath (ssh). The flat helper field on
  // meta keeps both shapes addressable from the same selector here.
  const workspaceRoot =
    workspace.location.kind === "local"
      ? workspace.location.rootPath
      : workspace.location.remotePath;
  const rel = relPath(filePath, workspaceRoot);
  // Files outside the workspace root resolve to the absolute path
  // (relPath's documented fallback). The protocol won't serve those,
  // so surface a status row rather than a broken image.
  if (rel === filePath) {
    return (
      <EmptyState
        title={t("imagePreview.outside_workspace")}
        tone="status"
        className="min-h-0"
      />
    );
  }

  const url = buildWorkspaceUrl(workspaceId, rel);
  return <ImageCanvas url={url} alt={rel} onNaturalSize={onNaturalSize} />;
}

interface ImageCanvasProps {
  url: string;
  alt: string;
  onNaturalSize?: (size: { w: number; h: number }) => void;
}

// ---------------------------------------------------------------------------
// Zoom tuning constants
// ---------------------------------------------------------------------------

// Lower bound prevents the image collapsing to invisible. Upper bound is
// generous enough for pixel-level inspection of common screenshots
// (e.g. zoom 16× on a 4K image is well into per-pixel territory).
const MIN_USER_SCALE = 0.1;
const MAX_USER_SCALE = 16;

// Exponential mapping of wheel delta → zoom factor. 0.005 gives a smooth
// trackpad feel (small frequent deltas) and a responsive but not jumpy
// mouse-wheel feel (large discrete deltas, capped via exp curve).
const ZOOM_SENSITIVITY = 0.005;

interface ZoomAnchor {
  /** Cursor position over the image, normalised to [0,1] in each axis. */
  ratioX: number;
  ratioY: number;
  /** Cursor viewport position at the moment of the wheel event. */
  cursorX: number;
  cursorY: number;
}

/**
 * Renders the actual `<img>` and owns the zoom/scroll behaviour.
 *
 * Error path covers two cases:
 *   - File deleted/moved on disk after the tab opened (404 from protocol).
 *   - Format the OS/Chromium can't decode (rare for the supported set).
 */
function ImageCanvas({ url, alt, onNaturalSize }: ImageCanvasProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState(1);
  const [userScale, setUserScale] = useState(1);
  const [errored, setErrored] = useState(false);

  // Anchor for the in-flight zoom: applied in useLayoutEffect after the new
  // dimensions commit, then cleared. Held in a ref so the wheel callback
  // and the post-commit corrector communicate without extra renders.
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);

  // Mirror userScale into a ref so the native wheel listener (mounted once)
  // can read the latest value without re-attaching on every state change.
  const userScaleRef = useRef(userScale);
  useEffect(() => {
    userScaleRef.current = userScale;
  }, [userScale]);

  // Recompute object-contain fit factor on container resize or natural-size
  // change. Independent of userScale so the user's zoom level persists
  // across panel resizes — the image refits its baseline, the user's
  // multiplier on top is preserved.
  useEffect(() => {
    if (!naturalSize) return;
    const el = containerRef.current;
    if (!el) return;
    const recompute = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      if (cw === 0 || ch === 0) return;
      setFitScale(Math.min(cw / naturalSize.w, ch / naturalSize.h));
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [naturalSize]);

  // Apply cursor-anchored scroll correction immediately after the new image
  // dimensions land in the DOM. useLayoutEffect runs before paint, so the
  // size change and the scroll correction appear as one frame — zooming
  // looks like the image scales around the cursor with no flicker.
  // userScale and fitScale are intentional triggers — the effect reads
  // through refs and simply needs to fire after every render that changes
  // the image's committed dimensions.
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

  // Native wheel listener — React's onWheel synthetic is passive in modern
  // versions, which means preventDefault inside it is a no-op. Electron's
  // default cmd-wheel binding zooms the entire WebContents; we need
  // passive: false to suppress that and apply image zoom instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // Cmd (mac) and Ctrl (other platforms) are the conventional zoom
      // modifiers across editors and browsers. Without a modifier, the
      // event falls through to native scroll on the overflow container.
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();

      const img = imgRef.current;
      if (!img) return;

      const current = userScaleRef.current;
      const factor = Math.exp(-e.deltaY * ZOOM_SENSITIVITY);
      const next = clamp(current * factor, MIN_USER_SCALE, MAX_USER_SCALE);
      // At the min/max boundary, skip setting state and anchor so a stale
      // anchor isn't left behind for the next legitimate zoom to consume.
      if (next === current) return;

      const rect = img.getBoundingClientRect();
      const ratioX = rect.width > 0 ? clamp01((e.clientX - rect.left) / rect.width) : 0.5;
      const ratioY = rect.height > 0 ? clamp01((e.clientY - rect.top) / rect.height) : 0.5;
      zoomAnchorRef.current = { ratioX, ratioY, cursorX: e.clientX, cursorY: e.clientY };
      setUserScale(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  if (errored) {
    return <EmptyState title={t("imagePreview.load_failed")} tone="status" className="min-h-0" />;
  }

  // Until the image loads we don't know its natural size yet, so render
  // with object-contain as the placeholder fit. Once onLoad fires we
  // switch to explicit width/height and the display size stays the same
  // (fitScale is computed to match object-contain), so there's no visible
  // jump on transition.
  const hasSize = naturalSize !== null;
  const displayW = hasSize ? naturalSize.w * fitScale * userScale : undefined;
  const displayH = hasSize ? naturalSize.h * fitScale * userScale : undefined;

  return (
    <div
      ref={containerRef}
      className="app-scrollbar flex-1 min-h-0 overflow-auto bg-[var(--surface-backdrop-bg)]"
    >
      <div className="min-w-full min-h-full flex items-center justify-center p-4">
        <img
          ref={imgRef}
          src={url}
          alt={alt}
          onLoad={(e) => {
            const t = e.currentTarget;
            const size = { w: t.naturalWidth, h: t.naturalHeight };
            setNaturalSize(size);
            onNaturalSize?.(size);
          }}
          onError={() => setErrored(true)}
          // maxWidth/maxHeight: 'none' override Tailwind Preflight's global
          // `img { max-width: 100%; height: auto; }`. Without this, our
          // explicit width is silently capped at the inner wrapper's width
          // while the explicit height applies normally — the image stretches
          // vertically only and the aspect ratio breaks on zoom-in.
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
