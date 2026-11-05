// PdfPreview — a PDF file page by page, as pdf.js's own viewer shows it:
// only the pages near the view are drawn, their text selectable, their
// links followed (internal ones scroll to their place; external ones open
// through the app's window.open policy). It zooms by the toolbar's steps, by
// cmd/ctrl + wheel, or to the panel's width, which it opens at.
//
// pdf.js is loaded with the first PDF, not with the app. The file's bytes
// come whole over fs.readBinary, for local and SSH workspaces alike, within
// the readable file size limit. Scripts in the file do not run: the viewer
// is given no scripting. A file changed on disk loads again at the same zoom
// and place.
//
// Find (⌘F) is pdf.js's own: it goes through the text of every page, drawn
// or not, and paints the matches in the pages' text layers.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { FIND_COLORS } from "../../../services/editor/preview/find/dom-finder";
import { nextZoomStep } from "../../../services/editor/preview/pdf";
import { readWorkspaceBinary } from "../../../services/editor/preview/read-binary";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { type FindResult, usePreviewFinder } from "./preview-find";
import { useFileVersion } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

type PdfJs = typeof import("pdfjs-dist");
type PdfViewerLib = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type PDFViewer = InstanceType<PdfViewerLib["PDFViewer"]>;
type PDFLinkService = InstanceType<PdfViewerLib["PDFLinkService"]>;

/** What is being found, as pdf.js's find takes it. */
interface PdfFind {
  readonly query: string;
  readonly caseSensitive: boolean;
}

/** Finds `find` anew (""), or the next or previous match ("again"). */
function dispatchFind(viewer: PDFViewer, find: PdfFind, type: "" | "again", findPrevious = false) {
  viewer.eventBus.dispatch("find", {
    source: null,
    type,
    query: find.query,
    caseSensitive: find.caseSensitive,
    entireWord: false,
    highlightAll: true,
    findPrevious,
    matchDiacritics: false,
  });
}

/**
 * What the app's styles change in the viewer's. The find's colors in the
 * pages' text layers, as the other previews paint them; pdf.js sets its own
 * on each highlight. And the pages' box: pdf.js sizes a page to the PDF's
 * with its border outside, but under the app's border-box the border took
 * its room from the drawn page, which was then smaller than the text layer
 * over it, so that the find's marks and the selection sat off the words.
 */
const VIEWER_STYLE = `.pdfViewer .page {
  box-sizing: content-box;
}
.pdfViewer .textLayer .highlight {
  --highlight-bg-color: ${FIND_COLORS.match};
  --highlight-selected-bg-color: ${FIND_COLORS.current};
}`;

let loading: Promise<{ pdfjs: PdfJs; lib: PdfViewerLib }> | null = null;

/** pdf.js, its viewer and the viewer's styles; the viewer finds pdf.js on globalThis. */
function loadPdfJs(): Promise<{ pdfjs: PdfJs; lib: PdfViewerLib }> {
  loading ??= (async () => {
    const pdfjs = await import("pdfjs-dist");
    (globalThis as { pdfjsLib?: PdfJs }).pdfjsLib = pdfjs;
    const [lib, worker] = await Promise.all([
      import("pdfjs-dist/web/pdf_viewer.mjs"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      import("pdfjs-dist/web/pdf_viewer.css"),
    ]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const style = document.createElement("style");
    style.textContent = VIEWER_STYLE;
    document.head.append(style);
    return { pdfjs, lib };
  })();
  return loading;
}

/** What the toolbar shows of the document and does to it. */
export interface PdfControls {
  readonly page: number;
  readonly pages: number;
  /** The zoom, as a fraction of actual size. */
  readonly scale: number;
  zoom(direction: 1 | -1): void;
  fitWidth(): void;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed" | "too_large" | "password" | "outside" | "no-workspace" };

interface PdfPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
  onControls?: (controls: PdfControls | null) => void;
}

export function PdfPreview({ workspaceId, filePath, onControls }: PdfPreviewProps) {
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") return <PdfStatus status={{ kind: file.kind }} />;
  return <PdfDocument workspaceId={workspaceId} relPath={file.relPath} onControls={onControls} />;
}

interface PdfDocumentProps {
  workspaceId: string;
  relPath: string;
  onControls?: (controls: PdfControls | null) => void;
}

/** Wheel delta to zoom factor, as the image preview zooms. */
const ZOOM_SENSITIVITY = 0.005;

function PdfDocument({ workspaceId, relPath, onControls }: PdfDocumentProps) {
  const version = useFileVersion(workspaceId, relPath);
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<{ viewer: PDFViewer; links: PDFLinkService } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [view, setView] = useState({ page: 1, pages: 0, scale: 1 });
  const findRef = useRef<PdfFind | null>(null);
  const reportRef = useRef<(result: FindResult) => void>(() => {});

  usePreviewFinder(
    useCallback((report: (result: FindResult) => void) => {
      reportRef.current = report;
      const close = () =>
        viewerRef.current?.viewer.eventBus.dispatch("findbarclose", { source: null });
      return {
        search(query: string, caseSensitive: boolean) {
          findRef.current = query.trim() ? { query, caseSensitive } : null;
          const viewer = viewerRef.current?.viewer;
          if (!findRef.current) {
            close();
            report({ total: 0, current: 0 });
          } else if (viewer?.pdfDocument) {
            dispatchFind(viewer, findRef.current, "");
          }
        },
        move(direction: 1 | -1) {
          const viewer = viewerRef.current?.viewer;
          if (viewer && findRef.current)
            dispatchFind(viewer, findRef.current, "again", direction === -1);
        },
        clear() {
          findRef.current = null;
          close();
        },
      };
    }, []),
  );

  const zoom = useCallback((direction: 1 | -1) => {
    const viewer = viewerRef.current?.viewer;
    if (viewer?.pdfDocument) viewer.currentScale = nextZoomStep(viewer.currentScale, direction);
  }, []);
  const fitWidth = useCallback(() => {
    const viewer = viewerRef.current?.viewer;
    if (viewer?.pdfDocument) viewer.currentScaleValue = "page-width";
  }, []);

  useEffect(() => {
    onControls?.(status.kind === "ready" ? { ...view, zoom, fitWidth } : null);
  }, [onControls, status.kind, view, zoom, fitWidth]);
  useEffect(() => () => onControls?.(null), [onControls]);

  // `version` is when to read the file again; the read itself goes by path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<PdfJs["getDocument"]> | null = null;
    /** Whether the viewer took the document, which it then destroys when done. */
    let shown = false;
    void (async () => {
      const read = await readWorkspaceBinary(workspaceId, relPath);
      if (cancelled) return;
      if (read.kind !== "ok") {
        setStatus({ kind: read.kind });
        return;
      }
      const { pdfjs, lib } = await loadPdfJs();
      const container = containerRef.current;
      const pages = pagesRef.current;
      if (cancelled || !container || !pages) return;
      viewerRef.current ??= createViewer(lib, container, pages, setView, (result) =>
        reportRef.current(result),
      );
      const { viewer, links } = viewerRef.current;
      task = pdfjs.getDocument({
        data: read.bytes,
        enableXfa: false,
      });
      try {
        const doc = await task.promise;
        if (cancelled) {
          void doc.loadingTask.destroy();
          return;
        }
        // A changed file keeps the zoom and place it was at.
        const previous = viewer.pdfDocument;
        const keep = previous
          ? {
              scale: viewer.currentScaleValue,
              top: container.scrollTop,
              left: container.scrollLeft,
            }
          : null;
        viewer.eventBus.on(
          "pagesinit",
          () => {
            viewer.currentScaleValue = keep?.scale ?? "page-width";
            if (keep) {
              container.scrollTop = keep.top;
              container.scrollLeft = keep.left;
            }
            // A changed file is found in again.
            if (findRef.current) dispatchFind(viewer, findRef.current, "");
          },
          { once: true },
        );
        viewer.setDocument(doc);
        links.setDocument(doc, null);
        shown = true;
        void previous?.loadingTask.destroy();
        setView((v) => ({ ...v, pages: doc.numPages }));
        setStatus({ kind: "ready" });
      } catch (error) {
        if (cancelled) return;
        const name = (error as { name?: string }).name;
        setStatus({ kind: name === "PasswordException" ? "password" : "failed" });
      }
    })();
    return () => {
      cancelled = true;
      if (!shown) void task?.destroy();
    };
  }, [workspaceId, relPath, version]);

  useEffect(
    () => () => {
      const viewer = viewerRef.current?.viewer;
      void viewer?.pdfDocument?.loadingTask.destroy();
      viewer?.setDocument(null as never);
    },
    [],
  );

  // Native, not React's passive onWheel: cmd/ctrl + wheel must not zoom the
  // whole window.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const viewer = viewerRef.current?.viewer;
      if (!viewer?.pdfDocument) return;
      viewer.updateScale({
        scaleFactor: Math.exp(-e.deltaY * ZOOM_SENSITIVITY),
        origin: [e.clientX, e.clientY],
      });
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="relative flex-1 min-h-0 bg-[var(--surface-backdrop-bg)]">
      {/* pdf.js wants its container absolutely placed, and laid out while it
          loads, to fit the pages to its width. */}
      <div
        ref={containerRef}
        className={cn(
          "app-scrollbar absolute inset-0 overflow-auto",
          status.kind !== "ready" && "invisible",
        )}
      >
        <div ref={pagesRef} className="pdfViewer" />
      </div>
      {status.kind !== "ready" && <PdfStatus status={status} />}
    </div>
  );
}

function createViewer(
  lib: PdfViewerLib,
  container: HTMLDivElement,
  pages: HTMLDivElement,
  setView: (update: (v: { page: number; pages: number; scale: number }) => typeof v) => void,
  onFound: (result: FindResult) => void,
): { viewer: PDFViewer; links: PDFLinkService } {
  const eventBus = new lib.EventBus();
  const links = new lib.PDFLinkService({ eventBus, externalLinkTarget: lib.LinkTarget.BLANK });
  const findController = new lib.PDFFindController({ eventBus, linkService: links });
  const viewer = new lib.PDFViewer({
    container,
    viewer: pages,
    eventBus,
    linkService: links,
    findController,
  });
  links.setViewer(viewer);
  eventBus.on("pagechanging", (e: { pageNumber: number }) => {
    setView((v) => ({ ...v, page: e.pageNumber }));
  });
  eventBus.on("scalechanging", (e: { scale: number }) => {
    setView((v) => ({ ...v, scale: e.scale }));
  });
  // The count grows as pages are searched, and the current match moves.
  const found = (e: { matchesCount?: { current: number; total: number } }) => {
    if (e.matchesCount) onFound({ total: e.matchesCount.total, current: e.matchesCount.current });
  };
  eventBus.on("updatefindmatchescount", found);
  eventBus.on("updatefindcontrolstate", found);
  return { viewer, links };
}

function PdfStatus({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status.kind === "loading" || status.kind === "ready") {
    return <div className="absolute inset-0" aria-busy />;
  }
  const title =
    status.kind === "too_large"
      ? t("pdfPreview.too_large", { maxMb: MAX_READABLE_FILE_SIZE / (1024 * 1024) })
      : status.kind === "password"
        ? t("pdfPreview.password")
        : status.kind === "outside"
          ? t("pdfPreview.outside_workspace")
          : status.kind === "no-workspace"
            ? t("imagePreview.workspace_not_found")
            : t("pdfPreview.load_failed");
  return <EmptyState title={title} tone="status" className="absolute inset-0 min-h-0" />;
}
