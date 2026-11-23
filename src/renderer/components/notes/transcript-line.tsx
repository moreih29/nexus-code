import { Plus } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  clockOf,
  type SpeakerMoveScope,
  type TranscriptLine,
} from "../../../shared/notes/transcript";
import { FIND_COLORS } from "../../services/editor/preview/find/dom-finder";
import {
  DropdownMenuAtPoint,
  DropdownMenuItem,
  type DropdownMenuPoint,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";

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
  suggested = false,
  color,
  marks,
  narrowed,
  lit,
  summaryTask = false,
  onSpeaker,
  onQuote,
  onShowInWhole,
}: {
  rowKey: string;
  recordingId: string;
  line: TranscriptLine;
  name: string;
  suggested?: boolean;
  color: string;
  marks: readonly number[];
  narrowed: boolean;
  lit: boolean;
  summaryTask?: boolean;
  onSpeaker: (recordingId: string, line: TranscriptLine, point: DropdownMenuPoint) => void;
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
      {summaryTask && (
        <span className="mr-1.5 inline-flex items-center whitespace-nowrap rounded-(--radius-control) border border-[var(--state-info-border)] bg-[var(--state-info-bg)] px-1 text-app-micro text-[var(--state-info-fg)]">
          {t("summary.task")}
        </span>
      )}
      <button
        type="button"
        aria-haspopup="menu"
        className={cn(
          "mr-1.5 rounded-(--radius-control) font-medium hover:bg-[var(--state-hover-bg)]",
          suggested && "text-muted-foreground",
        )}
        style={suggested ? undefined : { color }}
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

export function PartialRow({
  name,
  suggested = false,
  color,
  text,
  marks,
}: {
  name: string;
  suggested?: boolean;
  color: string;
  text: string;
  marks: readonly number[];
}) {
  return (
    <div className="text-app-ui-sm leading-5 text-muted-foreground italic">
      <span className="mr-1.5 font-medium not-italic" style={suggested ? undefined : { color }}>
        {name}
      </span>
      <Marked text={text} marks={marks} />
    </div>
  );
}

export interface LineTarget {
  readonly key: string;
  readonly name: string;
  readonly color: string;
}

export const LineMoveMenu = memo(function LineMoveMenu({
  point,
  targets,
  onMove,
  onClose,
}: {
  point: DropdownMenuPoint | null;
  targets: readonly LineTarget[];
  onMove: (to: string | null, scope: SpeakerMoveScope) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("notes");
  const scopes = [
    ["line", t("transcript.moveScope.line")],
    ["following", t("transcript.moveScope.following")],
    ["all", t("transcript.moveScope.all")],
  ] as const;
  const choices = [...targets, { key: null, name: t("transcript.newSpeaker"), color: null }];
  return (
    <DropdownMenuAtPoint point={point} onClose={onClose}>
      {choices.map(({ key, name, color }) => (
        <DropdownMenuSub key={key ?? "new"}>
          <DropdownMenuSubTrigger>
            <span className="flex items-center gap-2">
              {color ? (
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: color }}
                  aria-hidden="true"
                />
              ) : (
                <Plus className="size-3.5" aria-hidden="true" />
              )}
              {name}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {scopes.map(([scope, label]) => (
              <DropdownMenuItem key={scope} onSelect={() => onMove(key, scope)}>
                {label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
    </DropdownMenuAtPoint>
  );
});
