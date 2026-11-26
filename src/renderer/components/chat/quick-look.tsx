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
import { isUnder } from "../../../shared/fs/relative-path";
import { ipcCallResult } from "../../ipc/client";
import { useChatFiles } from "../../services/chat/chat-files";
import { copyImage, workspaceImageSrc } from "../../services/chat/copy-image";
import { imageLookSize, imageSrc, type Size } from "../../services/chat/image-look";
import { baseName, type LineAt } from "../../services/chat/links";
import type { ImageBlock } from "../../services/chat/model";
import { isImageFile } from "../../services/editor/preview/previewable";
import { peerOf } from "../../services/remote/peer-workspace";
import { useAgentViewStore } from "../../state/stores/agent-view";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { cn } from "../../utils/cn";
import { relativeTo } from "../../utils/path";
import { revealInOSLabel } from "../../utils/reveal-label";
import { ZoomableImage } from "../editor/preview/image-preview";
import { PreviewDraft } from "../editor/preview/preview-draft";
import { EmptyState } from "../ui/empty-state";
import { IconButton } from "../ui/icon-button";
import { showToast } from "../ui/toast";
import { tooltipProps } from "../ui/tooltip";
import { useImageBytes } from "./chat-image";
import { FileKindIcon } from "./file-kind-icon";

import { FileLookBody, FileLookControls, type FileLookOptions, useFileLookView } from "./file-look";

export interface QuickLookList {
  files: string[];
  index: number;
  draft?: File;
  changes?: Readonly<Record<string, string | null>>;
  at?: { path: string; line: number; column?: number };
  images?: Readonly<Record<string, ImageBlock>>;
  paths?: Readonly<Record<string, string>>;
}

const FROM_LOOK =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]';

interface QuickLookProps {
  workspaceId: string;
  list: QuickLookList;
  area: HTMLElement | null;
  onIndex: (index: number) => void;
  onClose: () => void;
  onOpenTab?: (path: string, at?: LineAt) => void;
  onOpenBeside?: (path: string, options: FileLookOptions) => boolean;
  openBesideInWorkspace?: boolean;
  peerRoot?: string;
  local: boolean;
  onRevert?: (path: string) => void;
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
  openBesideInWorkspace,
  peerRoot,
  local,
  onRevert,
  revertBlocked,
}: QuickLookProps) {
  const { t } = useTranslation();
  const { files, index, draft } = list;
  const path = files[index] ?? "";
  const count = files.length;
  const stepping = count > 1;
  const step = (by: number) => stepping && onIndex((index + by + count) % count);
  const before = list.changes?.[path];
  const line = list.at?.path === path ? list.at : undefined;
  const image = list.images?.[path];
  const imageFile = image ? list.paths?.[path] : undefined;
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

  const shownAsImage = image !== undefined || (isImageFile(path) && !showDiff);
  const canCopyImage =
    shownAsImage &&
    !draft &&
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
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), SIZE_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

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
                : workspaceImageSrc(workspaceId, peer ? path : relativeTo(path, root));
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
        {local && !draft && (!image || imageFile) && (
          <IconButton
            label={revealInOSLabel()}
            onClick={() =>
              void ipcCallResult("system", "revealInOS", { absPath: imageFile ?? path })
            }
          >
            <FolderOpen className="size-3.5" />
          </IconButton>
        )}
        {!draft &&
          (imageFile ?? (image ? "" : path)) &&
          (view === "agents" || openBesideInWorkspace) &&
          onOpenBeside && (
            <IconButton
              label={t("chat.look.open_beside")}
              onClick={() => {
                const opened = onOpenBeside(
                  imageFile ?? path,
                  imageFile ? {} : { at: line, before, mode: fileView.mode, compare: showDiff },
                );
                if (opened !== false) restoreFocus.current = false;
              }}
              data-testid="chat-quick-look-open-beside"
            >
              <Columns2 className="size-3.5" />
            </IconButton>
          )}
        {!draft && (!image || imageFile) && onOpenTab && (
          <IconButton
            label={t("chat.look.open_tab")}
            onClick={() => onOpenTab(imageFile ?? path, imageFile ? undefined : line)}
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
        ) : draft ? (
          <PreviewDraft file={draft}>
            <FileLookBody
              workspaceId={workspaceId}
              path={path}
              root=""
              view={fileView}
              onImageSize={sized(path)}
            />
          </PreviewDraft>
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

const BORDER_PX = 2;

const SIZE_WAIT_MS = 300;

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
