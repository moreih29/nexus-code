import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { READ_RANGE_MAX_BYTES } from "../../../../shared/fs/defaults";
import { pdfKept } from "../../../services/editor/preview/file-refresh";
import { FIND_COLORS } from "../../../services/editor/preview/find/dom-finder";
import { nextZoomStep } from "../../../services/editor/preview/pdf";
import { type FilePart, readWorkspaceRange } from "../../../services/editor/preview/read-range";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { type FindResult, usePreviewFinder } from "./preview-find";
import { useFileVersion } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

type PdfJs = typeof import("pdfjs-dist");
type PdfViewerLib = typeof import("pdfjs-dist/web/pdf_viewer.mjs");
type PDFViewer = InstanceType<PdfViewerLib["PDFViewer"]>;
type PDFLinkService = InstanceType<PdfViewerLib["PDFLinkService"]>;

interface PdfFind {
  readonly query: string;
  readonly caseSensitive: boolean;
}

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

const VIEWER_STYLE = `.pdfViewer .page {
  box-sizing: content-box;
}
.pdfViewer .textLayer .highlight {
  --highlight-bg-color: ${FIND_COLORS.match};
  --highlight-selected-bg-color: ${FIND_COLORS.current};
}`;

let loading: Promise<{ pdfjs: PdfJs; lib: PdfViewerLib }> | null = null;

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

export interface PdfControls {
  readonly page: number;
  readonly pages: number;
  readonly scale: number;
  zoom(direction: 1 | -1): void;
  fitWidth(): void;
}

type Status =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "failed" | "password" | "outside" | "no-workspace" };

interface PdfPreviewProps {
  workspaceId: string;
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
  const fitPendingRef = useRef(false);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let task: ReturnType<PdfJs["getDocument"]> | null = null;
    let shown = false;
    void (async () => {
      const head = await readWorkspaceRange(
        workspaceId,
        relPath,
        0,
        READ_RANGE_MAX_BYTES,
        undefined,
        abort.signal,
      ).catch(() => null);
      if (cancelled) return;
      if (!head) {
        setStatus({ kind: "failed" });
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
      const failed = () => {
        if (!cancelled) setStatus({ kind: "failed" });
      };
      task = pdfjs.getDocument(
        head.bytes.length >= head.size
          ? { data: head.bytes, enableXfa: false }
          : {
              range: rangeTransport(pdfjs, head, failed, (begin, end) =>
                readWorkspaceRange(
                  workspaceId,
                  relPath,
                  begin,
                  end - begin,
                  head.mtime,
                  abort.signal,
                ).catch(() => null),
              ),
              rangeChunkSize: PDF_CHUNK_BYTES,
              disableAutoFetch: true,
              disableStream: true,
              enableXfa: false,
            },
      );
      try {
        const doc = await task.promise;
        if (cancelled) {
          void doc.loadingTask.destroy();
          return;
        }
        const previous = viewer.pdfDocument;
        const keep = pdfKept(
          previous !== null && previous !== undefined,
          fitPendingRef.current,
          String(viewer.currentScaleValue),
          container.scrollTop,
          container.scrollLeft,
        );
        viewer.eventBus.on(
          "pagesinit",
          () => {
            const scale = keep?.scale ?? "page-width";
            fitPendingRef.current = scale === "page-width" && container.clientWidth === 0;
            if (!fitPendingRef.current) viewer.currentScaleValue = scale;
            if (keep) {
              container.scrollTop = keep.top;
              container.scrollLeft = keep.left;
            }
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
      abort.abort();
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

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const viewer = viewerRef.current?.viewer;
      if (!fitPendingRef.current || !viewer?.pdfDocument || container.clientWidth === 0) return;
      fitPendingRef.current = false;
      viewer.currentScaleValue = "page-width";
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="relative flex-1 min-h-0 bg-[var(--surface-backdrop-bg)]">
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

const PDF_CHUNK_BYTES = 256 * 1024;

function rangeTransport(
  pdfjs: PdfJs,
  head: FilePart,
  onFailed: () => void,
  read: (begin: number, end: number) => Promise<FilePart | null>,
): InstanceType<PdfJs["PDFDataRangeTransport"]> {
  const transport = new pdfjs.PDFDataRangeTransport(head.size, head.bytes);
  transport.requestDataRange = (begin, end) => {
    void read(begin, end).then((part) => {
      if (part) transport.onDataRange(begin, part.bytes);
      else onFailed();
    });
  };
  return transport;
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
    status.kind === "password"
      ? t("pdfPreview.password")
      : status.kind === "outside"
        ? t("pdfPreview.outside_workspace")
        : status.kind === "no-workspace"
          ? t("imagePreview.workspace_not_found")
          : t("pdfPreview.load_failed");
  return <EmptyState title={title} tone="status" className="absolute inset-0 min-h-0" />;
}
