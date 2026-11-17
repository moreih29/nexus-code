/**
 * A transcript's lines: when, who and what, the words searched for marked.
 * The speaker opens the one menu that moves a line to another voice; while
 * the transcript is narrowed to a person or a search, the time shows the
 * line in the whole conversation.
 */
import { Plus } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { clockOf, type TranscriptLine } from "../../../shared/notes/transcript";
import { FIND_COLORS } from "../../services/editor/preview/find/dom-finder";
import { DropdownMenuAtPoint, DropdownMenuItem, type DropdownMenuPoint } from "../ui/dropdown-menu";

/** `text` with the [start, end] spans in `marks` marked. */
function Marked({ text, marks }: { text: string; marks: readonly number[] }) {
  if (marks.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = 0; i + 1 < marks.length; i += 2) {
    const start = marks[i] as number;
    const end = marks[i + 1] as number;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark
        key={start}
        className="rounded-[2px] text-inherit"
        style={{ backgroundColor: FIND_COLORS.match }}
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export const LineRow = memo(function LineRow({
  rowKey,
  recordingId,
  line,
  name,
  color,
  marks,
  narrowed,
  lit,
  onSpeaker,
  onQuote,
  onShowInWhole,
}: {
  rowKey: string;
  recordingId: string;
  line: TranscriptLine;
  name: string;
  color: string;
  marks: readonly number[];
  /** The transcript leaves lines out: the time shows this one among them all. */
  narrowed: boolean;
  /** Just shown in the whole conversation: lit a moment. */
  lit: boolean;
  /** Opens the menu that moves the line to another voice, under its speaker. */
  onSpeaker: (recordingId: string, line: TranscriptLine, point: DropdownMenuPoint) => void;
  /** Puts the line into the note, as a quote. */
  onQuote: (recordingId: string, line: TranscriptLine) => void;
  onShowInWhole: (rowKey: string) => void;
}) {
  const { t } = useTranslation("notes");
  const time = clockOf(line.startMs);
  return (
    <div
      className={cn(
        "group relative rounded-(--radius-control) text-app-ui-sm leading-5 text-foreground transition-colors duration-500",
        lit && "bg-[var(--sidebar-item-selected-bg)]",
      )}
      data-testid="transcript-line"
      data-lit={lit || undefined}
    >
      {narrowed ? (
        <button
          type="button"
          className="mr-1.5 rounded-(--radius-control) text-app-micro text-muted-foreground tabular-nums hover:text-foreground hover:underline"
          onClick={() => onShowInWhole(rowKey)}
          title={t("transcript.inContext")}
          data-testid="transcript-line-time"
        >
          {time}
        </button>
      ) : (
        <span className="mr-1.5 text-app-micro text-muted-foreground tabular-nums">{time}</span>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        className="mr-1.5 rounded-(--radius-control) font-medium hover:bg-[var(--state-hover-bg)]"
        style={{ color }}
        title={t("transcript.moveLine")}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          onSpeaker(recordingId, line, { x: box.left, y: box.bottom + 4 });
        }}
        data-testid="transcript-line-speaker"
      >
        {name}
      </button>
      <Marked text={line.text} marks={marks} />
      <button
        type="button"
        className="absolute top-0 right-0 hidden size-5 items-center justify-center rounded-(--radius-control) border border-border bg-popover text-muted-foreground group-hover:inline-flex hover:text-foreground"
        onClick={() => onQuote(recordingId, line)}
        aria-label={t("transcript.insert")}
        title={t("transcript.insert")}
      >
        <Plus className="size-3" />
      </button>
    </div>
  );
});

/** The words being said now, before they are final. */
export function PartialRow({
  name,
  color,
  text,
  marks,
}: {
  name: string;
  color: string;
  text: string;
  marks: readonly number[];
}) {
  return (
    <div className="text-app-ui-sm leading-5 text-muted-foreground italic">
      <span className="mr-1.5 font-medium not-italic" style={{ color }}>
        {name}
      </span>
      <Marked text={text} marks={marks} />
    </div>
  );
}

/** A voice a line can be moved to. */
export interface LineTarget {
  readonly key: string;
  readonly name: string;
  readonly color: string;
}

/**
 * The one menu that moves a line to another voice of its recording, or to a
 * new one: opened under the speaker clicked, rather than a menu kept on
 * every line.
 */
export const LineMoveMenu = memo(function LineMoveMenu({
  point,
  targets,
  onMove,
  onClose,
}: {
  point: DropdownMenuPoint | null;
  /** The recording's other people. */
  targets: readonly LineTarget[];
  /** Moves the line to a voice, or to a new one (null). */
  onMove: (to: string | null) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("notes");
  return (
    <DropdownMenuAtPoint point={point} onClose={onClose}>
      {targets.map((o) => (
        <DropdownMenuItem
          key={o.key}
          className="justify-start gap-2"
          onSelect={() => onMove(o.key)}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ background: o.color }}
            aria-hidden="true"
          />
          {o.name}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem className="justify-start gap-2" onSelect={() => onMove(null)}>
        <Plus className="size-3.5" aria-hidden="true" />
        {t("transcript.newSpeaker")}
      </DropdownMenuItem>
    </DropdownMenuAtPoint>
  );
});
