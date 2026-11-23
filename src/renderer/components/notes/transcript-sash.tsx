import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  NOTE_TRANSCRIPT_SHARE_DEFAULT,
  NOTE_TRANSCRIPT_SHARE_MAX,
  NOTE_TRANSCRIPT_SHARE_MIN,
  NOTE_TRANSCRIPT_WIDTH_DEFAULT,
  NOTE_TRANSCRIPT_WIDTH_MAX,
  NOTE_TRANSCRIPT_WIDTH_MIN,
  useUIStore,
} from "../../state/stores/ui";
import { KEYBOARD_NUDGE_PX } from "../ui/resize-handle";
import { useDragHandle } from "../ui/use-drag-handle";

export const NOTE_TEXT_MIN = 320;

export function TranscriptSash({
  beside,
  panel,
}: {
  beside: boolean;
  panel: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation("notes");
  const width = useUIStore((s) => s.noteTranscriptWidth);
  const share = useUIStore((s) => s.noteTranscriptShare);
  const start = useRef(0);
  const body = () => panel.current?.parentElement ?? null;
  const resize = (grow: number, persist: boolean, from: number) => {
    const ui = useUIStore.getState();
    const box = body();
    if (beside) {
      const most = box ? box.clientWidth - NOTE_TEXT_MIN : NOTE_TRANSCRIPT_WIDTH_MAX;
      ui.setNoteTranscriptWidth(Math.min(from + grow, most), persist);
    } else if (box && box.clientHeight > 0) {
      ui.setNoteTranscriptShare(from + grow / box.clientHeight, persist);
    }
  };
  const { isDragging, handleMouseDown } = useDragHandle({
    orientation: beside ? "vertical" : "horizontal",
    onDragStart: () => {
      const ui = useUIStore.getState();
      start.current = beside ? ui.noteTranscriptWidth : ui.noteTranscriptShare;
    },
    onDragMove: (delta) => resize(-delta, false, start.current),
    onDragEnd: () => {
      const ui = useUIStore.getState();
      if (beside) ui.setNoteTranscriptWidth(ui.noteTranscriptWidth, true);
      else ui.setNoteTranscriptShare(ui.noteTranscriptShare, true);
    },
  });
  const nudge = (e: React.KeyboardEvent) => {
    const grow = beside
      ? { ArrowLeft: 1, ArrowRight: -1 }[e.key]
      : { ArrowUp: 1, ArrowDown: -1 }[e.key];
    if (!grow) return;
    e.preventDefault();
    resize(grow * KEYBOARD_NUDGE_PX, true, beside ? width : share);
  };
  const reset = () => {
    const ui = useUIStore.getState();
    if (beside) ui.setNoteTranscriptWidth(NOTE_TRANSCRIPT_WIDTH_DEFAULT, true);
    else ui.setNoteTranscriptShare(NOTE_TRANSCRIPT_SHARE_DEFAULT, true);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a sash is not a button or a rule
    <div
      role="separator"
      aria-orientation={beside ? "vertical" : "horizontal"}
      aria-label={t("transcript.resize")}
      aria-valuenow={beside ? width : Math.round(share * 100)}
      aria-valuemin={beside ? NOTE_TRANSCRIPT_WIDTH_MIN : NOTE_TRANSCRIPT_SHARE_MIN * 100}
      aria-valuemax={beside ? NOTE_TRANSCRIPT_WIDTH_MAX : NOTE_TRANSCRIPT_SHARE_MAX * 100}
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onDoubleClick={reset}
      onKeyDown={nudge}
      data-testid={beside ? "note-transcript-sash-beside" : "note-transcript-sash-under"}
      className={cn(
        "group absolute z-10 [-webkit-app-region:no-drag]",
        beside
          ? "top-0 left-0 hidden h-full w-2 -translate-x-1/2 cursor-col-resize @min-[720px]/note:block"
          : "top-0 right-0 left-0 h-2 -translate-y-1/2 cursor-row-resize @min-[720px]/note:hidden",
      )}
    >
      <div
        className={cn(
          "absolute bg-[var(--splitter-hover)]",
          beside ? "top-0 left-[3px] h-full w-0.5" : "top-[3px] left-0 h-0.5 w-full",
          !isDragging && "opacity-0 transition-opacity duration-100 group-hover:opacity-100",
        )}
      />
    </div>
  );
}
