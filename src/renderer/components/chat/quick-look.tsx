// Quick look: a file the conversation names, shown in the app's previews
// over the panels; an image, with the conversation's other images a step
// away. The sidebar and the title bar stay in sight, with what other agents
// ask. An image's box wraps it, fitted as large as the area lets it, so
// there is room around it to click away (imageLookSize); the arrows over its
// sides, and ← →, step through the images; ↗ opens the file as a tab; esc
// closes, as does clicking around it or going elsewhere.
// A file the session changed shows as a diff, and can be reverted. Images
// with no file, as a tool or the user gave them, show the same way from
// their data. Over another computer's chat it shows that computer's files,
// read through the room (services/remote/peer-workspace): the same viewers,
// read only, with nothing that opens or changes the file here.

import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  Copy,
  FolderOpen,
  Image as ImageIcon,
  SquareArrowOutUpRight,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ipcCallResult } from "../../ipc/client";
import { useChatFiles } from "../../services/chat/chat-files";
import { copyImage, workspaceImageSrc } from "../../services/chat/copy-image";
import { imageLookSize, imageSrc, type Size } from "../../services/chat/image-look";
import { baseName, isUnder, type LineAt } from "../../services/chat/links";
import type { ImageBlock } from "../../services/chat/model";
import { isImageFile } from "../../services/editor/preview/previewable";
import { peerOf } from "../../services/remote/peer-workspace";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { relPath } from "../../utils/path";
import { revealInOSLabel } from "../../utils/reveal-label";
import { ZoomableImage } from "../editor/preview/image-preview";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";
import { tooltipProps } from "../ui/tooltip";
import { useImageBytes } from "./chat-image";
import { FileKindIcon } from "./file-kind-icon";

import { FileLookBody, FileLookControls, type FileLookOptions, useFileLookView } from "./file-look";

export interface QuickLookList {
  /** Absolute paths, or keys of `images`: the conversation's images, or the one file opened. */
  files: string[];
  index: number;
  /**
   * The files the session changed, by what each was before it (null for
   * one it wrote new); each opens as a diff.
   */
  changes?: Readonly<Record<string, string | null>>;
  /** The line a link named in one of the files, which opens there, in its source. */
  at?: { path: string; line: number; column?: number };
  /**
   * Images with no file, by the key `files` holds each by
   * (services/chat/image-look): shown from their data.
   */
  images?: Readonly<Record<string, ImageBlock>>;
}

/** Overlays that open from quick look, as the revert confirmation, and keep it open. */
const FROM_LOOK =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]';

interface QuickLookProps {
  workspaceId: string;
  list: QuickLookList;
  /** Where it shows (lookAreaOf); over the tab when null. */
  area: HTMLElement | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** Opens the file as a tab of its own, at the line a link named in it; none for another computer's. */
  onOpenTab?: (path: string, at?: LineAt) => void;
  onOpenBeside?: (path: string, options: FileLookOptions) => void;
  /** The folder of a workspace on another computer. */
  peerRoot?: string;
  /** Whether the workspace is on this machine, where Finder can show a file. */
  local: boolean;
  /** Puts a changed file in the workspace back as it was before the session. */
  onRevert?: (path: string) => void;
  /** Why reverting is not possible now, as while Claude works. */
  revertBlocked?: string;
}

export function QuickLook({
  workspaceId,
  list,
  area,
  onIndex,
  onClose,
  onOpenTab,
  onOpenBeside,
  peerRoot,
  local,
  onRevert,
  revertBlocked,
}: QuickLookProps) {
  const { t } = useTranslation();
  const { files, index } = list;
  const path = files[index] ?? "";
  const count = files.length;
  // Only the conversation's images come as a list to step through.
  const stepping = count > 1;
  const step = (by: number) => stepping && onIndex((index + by + count) % count);
  const before = list.changes?.[path];
  const line = list.at?.path === path ? list.at : undefined;
  const image = list.images?.[path];
  // Another computer's image comes without its bytes, which are fetched.
  const shownImage = useImageBytes(image);
  const name = image ? t("chat.look.image", { number: index + 1 }) : baseName(path);
  const localRoot = useWorkspacesStore((s) => {
    const location = s.workspaces.find((w) => w.id === workspaceId)?.location;
    if (!location) return "";
    return location.kind === "local" ? location.rootPath : location.remotePath;
  });
  const root = peerRoot ?? localRoot;
  const peer = peerOf(workspaceId) !== null;
  const chatFiles = useChatFiles();
  const fileView = useFileLookView(path, { at: line, before });
  const { changed, showDiff } = fileView;

  // An image's box wraps it, once its size is known; until the next one
  // loads, the box keeps the size of the one before.
  const shownAsImage = image !== undefined || (isImageFile(path) && !showDiff);
  const canCopyImage =
    shownAsImage &&
    (image ? shownImage.image !== null : peer ? chatFiles?.epoch !== null : isUnder(path, root));
  const [sizes, setSizes] = useState<Readonly<Record<string, Size>>>({});
  const [lastSize, setLastSize] = useState<Size | null>(null);
  const sized = (of: string) => (size: Size) => {
    setSizes((known) =>
      known[of]?.w === size.w && known[of]?.h === size.h ? known : { ...known, [of]: size },
    );
    setLastSize(size);
  };
  const layerRef = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState<Size | null>(null);
  useLayoutEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const measure = () => setAreaSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const natural = sizes[path] ?? lastSize;
  const box =
    shownAsImage && areaSize && natural ? imageLookSize(areaSize, natural, BORDER_PX) : null;
  // The first image shows in its box, not first in the big one; one that
  // has not loaded in a moment shows in the big one.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), SIZE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // The keys go to the overlay while it is open; the focus goes back after,
  // unless it went elsewhere, which closed it.
  const rootRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(true);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    root?.focus();
    return () => {
      const now = document.activeElement;
      if (restoreFocus.current && (!now || now === document.body || root?.contains(now))) {
        before?.focus?.();
      }
    };
  }, []);

  // Going elsewhere closes it: to the workspaces or the agents, or to
  // another tab or agent, as a shortcut or a click in the sidebar does.
  const view = useAgentViewStore((s) => s.mode);
  const openedIn = useRef(view);
  useEffect(() => {
    if (view !== openedIn.current) onClose();
  }, [view, onClose]);
  const onBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Element | null;
    if (!next || rootRef.current?.contains(next) || next.closest(FROM_LOOK)) return;
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    // Where the arrows move a caret, they are left to it.
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true'], .monaco-editor")) return;
    event.preventDefault();
    step(event.key === "ArrowRight" ? 1 : -1);
  };

  const dialog = (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.look.aria", { name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={cn(
        "absolute flex flex-col overflow-hidden rounded-(--radius-island) border border-[var(--surface-floating-border)] bg-background outline-none",
        box ? "inset-0 m-auto" : "inset-4 @xl:inset-8 @3xl:inset-12",
        shownAsImage && !box && !waited && "opacity-0",
      )}
      style={box ? { width: box.w, height: box.h } : undefined}
      data-testid="chat-quick-look"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        {image ? (
          <ImageIcon className="ml-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <FileKindIcon path={path} className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 truncate text-app-ui-sm" title={image ? name : path}>
          {name}
        </span>
        {stepping && (
          <span className="shrink-0 px-1 text-app-micro tabular-nums text-muted-foreground">
            {index + 1} / {count}
          </span>
        )}
        <span className="flex-1" />
        {!image && <FileLookControls path={path} view={fileView} />}
        {changed && onRevert && isUnder(path, root) && (
          // A disabled button takes no pointer: its wrapper says why.
          <span className="inline-flex" {...(revertBlocked ? tooltipProps(revertBlocked) : {})}>
            <IconButton
              label={t("chat.look.revert")}
              onClick={() => onRevert(path)}
              disabled={revertBlocked !== undefined}
              data-testid="chat-quick-look-revert"
            >
              <Undo2 className="size-3.5" />
            </IconButton>
          </span>
        )}
        {canCopyImage && (
          <IconButton
            label={t("chat.look.copy_image")}
            onClick={() => {
              const src = image
                ? Promise.resolve(shownImage.image ? imageSrc(shownImage.image) : null)
                : workspaceImageSrc(workspaceId, peer ? path : relPath(path, root));
              void src
                .then((data) => {
                  if (data === null) throw new Error(t("chat.look.copy_image_unread"));
                  return copyImage(data);
                })
                .then(
                  () => showToast({ kind: "info", message: t("chat.look.copied_image") }),
                  (failure: unknown) =>
                    showToast({
                      kind: "error",
                      message: t("chat.look.copy_image_failed", {
                        error: (failure as Error).message,
                      }),
                    }),
                );
            }}
            data-testid="chat-quick-look-copy"
          >
            <Copy className="size-3.5" />
          </IconButton>
        )}
        {local && !image && (
          <IconButton
            label={revealInOSLabel()}
            onClick={() => void ipcCallResult("system", "revealInOS", { absPath: path })}
          >
            <FolderOpen className="size-3.5" />
          </IconButton>
        )}
        {path && !image && view === "agents" && onOpenBeside && (
          <IconButton
            label={t("chat.look.open_beside")}
            onClick={() => {
              restoreFocus.current = false;
              onOpenBeside(path, { at: line, before, mode: fileView.mode, compare: showDiff });
            }}
            data-testid="chat-quick-look-open-beside"
          >
            <Columns2 className="size-3.5" />
          </IconButton>
        )}
        {!image && onOpenTab && (
          <IconButton
            label={t("chat.look.open_tab")}
            onClick={() => onOpenTab(path, line)}
            data-testid="chat-quick-look-open"
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </IconButton>
        )}
        <IconButton label={t("chat.look.close")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="group/body relative min-h-0 flex-1">
        {image ? (
          shownImage.image ? (
            <div key={path} className="flex h-full">
              <ZoomableImage
                src={imageSrc(shownImage.image)}
                alt={name}
                onNaturalSize={sized(path)}
                fill
              />
            </div>
          ) : (
            <EmptyState
              key={path}
              title={shownImage.failed ? t("chat.look.copy_image_unread") : t("editor.loading")}
              tone="status"
              className="h-full"
            />
          )
        ) : (
          <FileLookBody
            workspaceId={workspaceId}
            path={path}
            root={root}
            at={line}
            before={before}
            view={fileView}
            onImageSize={sized(path)}
          />
        )}
        {stepping && (
          <>
            <StepButton side="left" label={t("chat.look.previous")} onStep={() => step(-1)} />
            <StepButton side="right" label={t("chat.look.next")} onStep={() => step(1)} />
          </>
        )}
      </div>
    </div>
  );
  const layer = (
    <div ref={layerRef} className="@container absolute inset-0 z-(--layer-in-panel)">
      <div
        aria-hidden
        className="absolute inset-0 bg-[var(--floating-scrim)]"
        onMouseDown={(event) => {
          // The focus goes back where it was, not to the page.
          event.preventDefault();
          onClose();
        }}
        data-testid="chat-quick-look-scrim"
      />
      {dialog}
    </div>
  );
  return area ? createPortal(layer, area) : layer;
}

/** The dialog's border, both sides together. */
const BORDER_PX = 2;

/** How long an image may take to load before it shows in the big box. */
const SIZE_WAIT_MS = 300;

/**
 * A round button over a side of the image, to step to the one before or
 * after: in sight while the pointer is over the image, or it has the focus.
 */
function StepButton({
  side,
  label,
  onStep,
}: {
  side: "left" | "right";
  label: string;
  onStep: () => void;
}) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onStep}
      className={cn(
        "absolute top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--surface-floating-border)] bg-popover/80 text-foreground opacity-0 shadow-md outline-none backdrop-blur-sm transition-opacity",
        "group-hover/body:opacity-100 hover:bg-popover focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring",
        side === "left" ? "left-3" : "right-3",
      )}
      data-testid={`chat-quick-look-${side === "left" ? "previous" : "next"}`}
    >
      <Icon className="size-4" />
    </button>
  );
}
