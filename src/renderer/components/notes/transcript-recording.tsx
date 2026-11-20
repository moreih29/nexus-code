/**
 * A recording's heading in the transcript: when it was made and how long it
 * runs, how far its second pass is, its menu, and its people. A person's
 * chip shows only what they said (and back to everyone, clicked again); the
 * pencil in a picked chip names them, which names each of their voices.
 * The person picked is also shown above the lines (`PickedSpeaker`), where
 * it stays as the recording scrolls away.
 */
import { Loader2, MoreHorizontal, Pencil, Sparkles, Trash2, X } from "lucide-react";
import { memo, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { dateTimeFormat } from "@/utils/intl-format";
import {
  clockOf,
  recordingMs,
  speakerName,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { canSecondPass, runSecondPass, useSecondPassStore } from "../../services/notes/second-pass";
import { removeRecording } from "../../services/notes/transcripts";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { type Cast, isNamed, speakerColor } from "./transcript-rows";

export const RecordingHeading = memo(function RecordingHeading({
  workspaceId,
  noteId,
  recording,
  cast,
  live,
  first,
  picked,
  names,
  onPick,
  onName,
}: {
  workspaceId: string;
  noteId: string;
  recording: TranscriptRecording;
  cast: Cast;
  live: boolean;
  /** The note's first recording: no room above it. */
  first: boolean;
  /** The person of this recording whose lines alone are shown, if one is. */
  picked: string | null;
  /** Names used in this note, offered when naming a person. */
  names: readonly string[];
  /** Shows only `person`'s lines, or everyone's again when they already are. */
  onPick: (recordingId: string, person: string) => void;
  /** Names a person: each of their voices. */
  onName: (recordingId: string, keys: readonly string[], name: string) => void;
}) {
  const { t, i18n } = useTranslation("notes");
  const refining = useSecondPassStore((s) => Boolean(s.running[recording.id]));
  const refined = recording.takes.length > 0 && recording.takes.every((tk) => tk.pass === "done");
  const startedAt = dateTimeFormat(i18n.language || "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(recording.startedAt));
  const unnamed = (key: string) => t("transcript.speaker", { label: key });

  const removeAll = async () => {
    const ok = await showConfirmDialog({
      title: t("transcript.removeConfirm.title"),
      description: t("transcript.removeConfirm.description"),
      confirmLabel: t("transcript.removeConfirm.confirm"),
      variant: "destructive",
    });
    if (ok) await removeRecording(workspaceId, noteId, recording.id, true);
  };

  return (
    <div className={cn(!first && "pt-2.5")} data-testid="transcript-recording">
      <div className="flex items-center gap-1.5 py-1 text-app-micro text-muted-foreground">
        <span className="truncate">
          {startedAt} · {clockOf(recordingMs(recording))}
        </span>
        {live ? (
          <span className="shrink-0 whitespace-nowrap text-[var(--state-error-fg)]">
            {t("transcript.live")}
          </span>
        ) : refining ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("transcript.refining")}
          </span>
        ) : refined ? (
          <span className="shrink-0">{t("transcript.refined")}</span>
        ) : null}
        {!live && (
          <DropdownMenuRoot>
            <DropdownMenuTrigger>
              <button
                type="button"
                className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) hover:bg-[var(--state-hover-bg)] hover:text-foreground"
                aria-label={t("editor.more")}
                title={t("editor.more")}
              >
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canSecondPass(recording) && !refining && (
                <DropdownMenuItem
                  onSelect={() => void runSecondPass(workspaceId, noteId, recording.id)}
                >
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  {t("transcript.refine")}
                </DropdownMenuItem>
              )}
              {!recording.audioRemoved && (
                <DropdownMenuItem
                  onSelect={() => void removeRecording(workspaceId, noteId, recording.id, false)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("transcript.removeAudio")}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void removeAll()}>
                <Trash2 className="size-3.5" aria-hidden="true" />
                {t("transcript.removeAll")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        )}
      </div>
      {cast.people.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cast.people.map(({ person, keys, color }) => (
            <SpeakerChip
              key={person}
              name={speakerName(recording, keys[0] as string, unnamed)}
              named={isNamed(person)}
              color={speakerColor(color)}
              picked={picked === person}
              names={names}
              onPick={() => onPick(recording.id, person)}
              onName={(name) => onName(recording.id, keys, name)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function SpeakerChip({
  name,
  named,
  color,
  picked,
  names,
  onPick,
  onName,
}: {
  name: string;
  named: boolean;
  color: string;
  picked: boolean;
  names: readonly string[];
  onPick: () => void;
  onName: (name: string) => void;
}) {
  const { t } = useTranslation("notes");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const listId = useId();
  if (editing) {
    const done = (save: boolean) => {
      if (save) onName(value);
      setEditing(false);
    };
    return (
      <>
        <input
          // biome-ignore lint/a11y/noAutofocus: it opens to be typed in
          autoFocus
          value={value}
          list={listId}
          placeholder={t("transcript.namePlaceholder")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => done(true)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") done(true);
            else if (e.key === "Escape") {
              // Cancels the name only; the transcript keeps what it shows.
              e.stopPropagation();
              done(false);
            }
          }}
          className="h-6 w-28 rounded-(--radius-pill) border border-ring bg-transparent px-2 text-app-micro text-foreground outline-none"
          data-testid="speaker-name-input"
        />
        <datalist id={listId}>
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-(--radius-pill) border text-app-micro",
        picked
          ? "border-ring bg-[var(--sidebar-item-selected-bg)] text-foreground"
          : named
            ? "border-border text-foreground"
            : "border-dashed border-border text-muted-foreground",
      )}
    >
      <button
        type="button"
        aria-pressed={picked}
        className={cn(
          "inline-flex h-full items-center gap-1.5 rounded-(--radius-pill) hover:bg-[var(--state-hover-bg)]",
          picked ? "pr-1 pl-2" : "px-2",
        )}
        onClick={onPick}
        title={picked ? t("transcript.everyone") : t("transcript.only")}
        data-testid="speaker-chip"
      >
        <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
        {name}
      </button>
      {picked && (
        <button
          type="button"
          className="mr-0.5 inline-flex size-5 items-center justify-center rounded-(--radius-pill) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          onClick={() => {
            setValue(named ? name : "");
            setEditing(true);
          }}
          aria-label={t("transcript.rename")}
          title={t("transcript.rename")}
          data-testid="speaker-chip-rename"
        >
          <Pencil className="size-3" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/**
 * The person the transcript shows alone, above its lines: their chip in the
 * recording scrolls away with it, this one stays. Clicked, everyone again.
 */
export function PickedSpeaker({
  name,
  color,
  onClear,
}: {
  name: string;
  color: string | null;
  onClear: () => void;
}) {
  const { t } = useTranslation("notes");
  return (
    <button
      type="button"
      className="inline-flex h-6 min-w-0 items-center gap-1.5 rounded-(--radius-pill) border border-ring bg-[var(--sidebar-item-selected-bg)] pr-1 pl-2 text-app-micro text-foreground hover:bg-[var(--state-hover-bg)]"
      onClick={onClear}
      title={t("transcript.everyone")}
      data-testid="transcript-picked"
    >
      {color && (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{name}</span>
      <span className="sr-only">{t("transcript.everyone")}</span>
      <X className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
