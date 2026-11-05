// PptxPreview — a .pptx presentation, read-only: its slides one after
// another, each with its number above and its speaker notes below.
//
// pptxtojson reads the file; slide-dom draws each slide as the file places
// its text, shapes, pictures and tables, on the slide's layout. Charts,
// video and audio are marked where they sit, not drawn. Slides wider than
// the panel shrink to its width. The slides are drawn into a shadow root,
// so the app's styles do not reach them. A file changed on disk is drawn
// again at the same place.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { createLogger } from "../../../../shared/log/renderer";
import { readWorkspaceBinary } from "../../../services/editor/preview/read-binary";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { drawPresentation, SLIDE_STYLE } from "./slide-dom";
import { useFileVersion } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

const log = createLogger("pptx-preview");

/** Space beside the slides, in px, as SLIDE_STYLE pads them. */
const DECK_GUTTER_PX = 16;
/** The smallest slides are shrunk to fit a narrow panel. */
const MIN_ZOOM = 0.2;
/** CSS px in a point. */
const PX_PER_PT = 4 / 3;

type Status =
  | { kind: "loading" | "ready" }
  | { kind: "failed" | "too_large" | "outside" | "no-workspace" };

interface PptxPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
}

export function PptxPreview({ workspaceId, filePath }: PptxPreviewProps) {
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") return <PptxStatus status={{ kind: file.kind }} />;
  return <PptxDocument workspaceId={workspaceId} relPath={file.relPath} />;
}

function PptxDocument({ workspaceId, relPath }: { workspaceId: string; relPath: string }) {
  const { t } = useTranslation();
  const version = useFileVersion(workspaceId, relPath);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  /** A slide's width at actual size, in px; 0 before the deck is drawn. */
  const slideWidth = useRef(0);

  /** The zoom the slides are drawn at; 0 before the first fit. */
  const zoomRef = useRef(0);
  /**
   * Slides wider than the panel shrink to its width. A tab not shown sits
   * in a box of no size, which is not fitted to; a panel that changes
   * width keeps the same place in the deck.
   */
  const fit = useCallback(() => {
    const host = hostRef.current;
    const container = scrollRef.current;
    if (!host || !container || slideWidth.current === 0 || container.clientWidth === 0) return;
    const room = container.clientWidth - 2 * DECK_GUTTER_PX;
    const zoom = Math.min(1, Math.max(MIN_ZOOM, room / slideWidth.current));
    const before = zoomRef.current;
    if (zoom === before) return;
    zoomRef.current = zoom;
    // Read before the slides shrink, which would clamp it.
    const top = container.scrollTop;
    host.style.setProperty("--slide-zoom", String(zoom));
    if (before > 0) container.scrollTop = top * (zoom / before);
  }, []);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [fit]);

  // `version` is when to read the file again; the read itself goes by path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const read = await readWorkspaceBinary(workspaceId, relPath);
      if (cancelled) return;
      if (read.kind !== "ok") {
        setStatus({ kind: read.kind });
        return;
      }
      const { parse } = await import("pptxtojson");
      let deck: HTMLElement;
      try {
        const { bytes } = read;
        const presentation = await parse(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          { imageMode: "base64", videoMode: "none", audioMode: "none" },
        );
        if (cancelled) return;
        slideWidth.current = presentation.size.width * PX_PER_PT;
        deck = drawPresentation(presentation, {
          slide: (number, count) => t("pptxPreview.slide_number", { number, count }),
          chart: t("pptxPreview.chart"),
          media: t("pptxPreview.media"),
        });
      } catch (error) {
        if (!cancelled) {
          log.warn(`could not draw ${relPath}: ${String(error)}`);
          setStatus({ kind: "failed" });
        }
        return;
      }
      const host = hostRef.current;
      if (cancelled || !host) return;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SLIDE_STYLE;
      fit();
      shadow.replaceChildren(style, deck);
      setStatus({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, relPath, version]);

  return (
    <div className="relative flex-1 min-h-0 bg-[var(--surface-backdrop-bg)]">
      <div
        ref={scrollRef}
        className={cn(
          "app-scrollbar absolute inset-0 overflow-auto",
          status.kind !== "ready" && "invisible",
        )}
      >
        <div ref={hostRef} />
      </div>
      {status.kind !== "ready" && <PptxStatus status={status} />}
    </div>
  );
}

function PptxStatus({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status.kind === "loading" || status.kind === "ready") {
    return <div className="absolute inset-0" aria-busy />;
  }
  const title =
    status.kind === "too_large"
      ? t("pptxPreview.too_large", { maxMb: MAX_READABLE_FILE_SIZE / (1024 * 1024) })
      : status.kind === "outside"
        ? t("pptxPreview.outside_workspace")
        : status.kind === "no-workspace"
          ? t("imagePreview.workspace_not_found")
          : t("pptxPreview.load_failed");
  return <EmptyState title={title} tone="status" className="absolute inset-0 min-h-0" />;
}
