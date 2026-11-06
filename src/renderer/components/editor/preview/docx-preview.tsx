// DocxPreview — a .docx document, read-only, laid out as pages the way the
// file sets them: text and its styles, lists, tables, pictures, headers,
// footers and notes. Pages wider than the panel are shrunk to its width.
//
// docx-preview draws it into a shadow root, so the document's styles and
// the app's stay apart. Links go where the Markdown preview's go: out to
// the browser, to a workspace file, or to a place in the document. Embedded
// HTML (altChunk) and comments are not shown, and macros do not run. A file
// changed on disk is drawn again at the same place. Bullets and symbols set
// in Word's symbol fonts are drawn as the Unicode characters they stand for.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_READABLE_FILE_SIZE } from "../../../../shared/fs/defaults";
import { createLogger } from "../../../../shared/log/renderer";
import { openOrRevealEditor } from "../../../services/editor";
import {
  classifyLinkHref,
  type LinkClassifyContext,
} from "../../../services/editor/preview/link-router";
import { readWorkspaceBinary } from "../../../services/editor/preview/read-binary";
import { useWorkspacesStore } from "../../../state/stores/workspaces";
import { cn } from "../../../utils/cn";
import { EmptyState } from "../../ui/empty-state";
import { unicodeSymbols } from "./docx-symbols";
import { useFileVersion } from "./use-file-version";
import { useWorkspaceFile } from "./use-workspace-file";

const log = createLogger("docx-preview");

type DocxPreviewLib = typeof import("docx-preview");

let loading: Promise<DocxPreviewLib> | null = null;
function loadDocxPreview(): Promise<DocxPreviewLib> {
  loading ??= import("docx-preview");
  return loading;
}

/** The smallest the pages are shrunk to fit a narrow panel. */
const MIN_ZOOM = 0.25;

const OPTIONS = {
  className: "docx",
  inWrapper: true,
  breakPages: true,
  // Word marks where it last broke pages; following it pages the document
  // as Word showed it.
  ignoreLastRenderedPageBreak: false,
  // An altChunk is HTML, which docx-preview puts in an unsandboxed iframe.
  renderAltChunks: false,
  renderComments: false,
  renderChanges: false,
  // Data URLs rather than blob URLs, which nothing would revoke.
  useBase64URL: true,
  experimental: false,
} as const;

/** Space beside the pages, in px. */
const PAGE_GUTTER_PX = 16;

/**
 * The pages on the editor's backdrop, rather than docx-preview's gray, and
 * centered only while they fit: a wider page scrolls from its left edge.
 */
const PAGE_STYLE = `
:host { display: block; color: #000; color-scheme: light; }
:host .docx-wrapper { background: transparent; padding: 24px ${PAGE_GUTTER_PX}px 0; align-items: safe center; }
:host .docx-wrapper > section.docx { box-shadow: 0 1px 4px rgb(0 0 0 / 0.35); margin-bottom: 24px; }
`;

type Status =
  | { kind: "loading" | "ready" }
  | { kind: "failed" | "too_large" | "outside" | "no-workspace" };

interface DocxPreviewProps {
  workspaceId: string;
  /** Absolute path on the workspace filesystem. */
  filePath: string;
}

export function DocxPreview({ workspaceId, filePath }: DocxPreviewProps) {
  const file = useWorkspaceFile(workspaceId, filePath);
  if (file.kind !== "inside") return <DocxStatus status={{ kind: file.kind }} />;
  return <DocxDocument workspaceId={workspaceId} relPath={file.relPath} filePath={filePath} />;
}

interface DocxDocumentProps {
  workspaceId: string;
  relPath: string;
  filePath: string;
}

function DocxDocument({ workspaceId, relPath, filePath }: DocxDocumentProps) {
  const version = useFileVersion(workspaceId, relPath);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The widest page's width at actual size, in px; 0 before one is drawn. */
  const pageWidth = useRef(0);
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const workspaceRootAbsPath = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.rootPath ?? "",
  );
  const linkCtx: LinkClassifyContext = useMemo(
    () => ({ currentFileAbsPath: filePath, workspaceRootAbsPath, kind: "link" }),
    [filePath, workspaceRootAbsPath],
  );

  /** The zoom the pages are drawn at; 0 before the first fit. */
  const zoomRef = useRef(0);
  /**
   * Pages wider than the panel are shrunk to its width, as the PDF preview
   * opens. A tab not shown sits in a box of no size, which is not fitted
   * to: its pages keep their zoom, and so its place. A panel that changes
   * width keeps the same place in the document.
   */
  const fit = useCallback(() => {
    const wrapper = hostRef.current?.shadowRoot?.querySelector<HTMLElement>(".docx-wrapper");
    const container = scrollRef.current;
    if (!wrapper || !container || pageWidth.current === 0) return;
    const before = zoomRef.current;
    if (container.clientWidth === 0) {
      if (before > 0) wrapper.style.zoom = String(before);
      return;
    }
    const room = container.clientWidth - 2 * PAGE_GUTTER_PX;
    const zoom = Math.min(1, Math.max(MIN_ZOOM, room / pageWidth.current));
    // Read before the pages shrink, which would clamp it.
    const top = container.scrollTop;
    // A changed file is a new wrapper, which takes the zoom afresh.
    wrapper.style.zoom = String(zoom);
    zoomRef.current = zoom;
    if (before > 0 && zoom !== before) container.scrollTop = top * (zoom / before);
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
      const { renderAsync } = await loadDocxPreview();
      // Drawn apart from the page, then swapped in whole, so a changed
      // file keeps its place rather than collapsing while it draws.
      const body = document.createElement("div");
      const styles = document.createElement("div");
      try {
        await renderAsync(read.bytes, body, styles, OPTIONS);
      } catch (error) {
        if (!cancelled) {
          log.warn(`could not draw ${relPath}: ${String(error)}`);
          setStatus({ kind: "failed" });
        }
        return;
      }
      unicodeSymbols(styles, body);
      const host = hostRef.current;
      if (cancelled || !host) return;
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const own = document.createElement("style");
      own.textContent = PAGE_STYLE;
      shadow.replaceChildren(styles, own, body);
      pageWidth.current = Math.max(
        0,
        ...Array.from(
          body.querySelectorAll<HTMLElement>("section.docx"),
          (page) => page.offsetWidth,
        ),
      );
      fit();
      setStatus({ kind: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, relPath, version]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      const anchor = e
        .composedPath()
        .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);
      if (!anchor) return;
      // Nothing in the document navigates the app: every link goes
      // through the same checks as the Markdown preview's.
      e.preventDefault();
      if (e.type !== "click") return;
      const classified = classifyLinkHref(anchor.getAttribute("href") ?? "", linkCtx);
      switch (classified.kind) {
        case "anchor":
          host.shadowRoot
            ?.getElementById(decodeURIComponent(classified.id))
            ?.scrollIntoView({ block: "start" });
          return;
        case "external":
          // Routes through setWindowOpenHandler, which allows only some schemes.
          window.open(classified.href, "_blank", "noopener,noreferrer");
          return;
        case "internal-file":
          openOrRevealEditor({ workspaceId, filePath: classified.absPath }, { preview: true });
          return;
        case "blocked":
          log.warn(`blocked link click: ${classified.reason}`);
          return;
      }
    };
    host.addEventListener("click", onClick);
    host.addEventListener("auxclick", onClick);
    return () => {
      host.removeEventListener("click", onClick);
      host.removeEventListener("auxclick", onClick);
    };
  }, [linkCtx, workspaceId]);

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
      {status.kind !== "ready" && <DocxStatus status={status} />}
    </div>
  );
}

function DocxStatus({ status }: { status: Status }) {
  const { t } = useTranslation();
  if (status.kind === "loading" || status.kind === "ready") {
    return <div className="absolute inset-0" aria-busy />;
  }
  const title =
    status.kind === "too_large"
      ? t("docxPreview.too_large", { maxMb: MAX_READABLE_FILE_SIZE / (1024 * 1024) })
      : status.kind === "outside"
        ? t("docxPreview.outside_workspace")
        : status.kind === "no-workspace"
          ? t("imagePreview.workspace_not_found")
          : t("docxPreview.load_failed");
  return <EmptyState title={title} tone="status" className="absolute inset-0 min-h-0" />;
}
