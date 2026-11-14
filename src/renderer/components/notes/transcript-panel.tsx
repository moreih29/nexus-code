/**
 * A note's transcript, beside its text: each recording with its voices and
 * what they said, a time to a line. While this note records, the words
 * come in as they are said. A voice is named by clicking it (the name goes
 * to every line of it); a line goes into the note as a quote; a recording
 * of more than one person is heard again, whole, once it ends.
 */
import { Loader2, MoreHorizontal, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { dateTimeFormat } from "@/utils/intl-format";
import {
  clockOf,
  joinedLines,
  recordingMs,
  speakerName,
  speakersOf,
  type TranscriptLine,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { useRecorderStore } from "../../services/notes/recorder";
import {
  canSecondPass,
  resumeSecondPasses,
  runSecondPass,
  useSecondPassStore,
} from "../../services/notes/second-pass";
import {
  loadTranscript,
  nameSpeaker,
  removeRecording,
  transcriptKey,
  useTranscriptsStore,
} from "../../services/notes/transcripts";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** A voice's color, by the order it first spoke. */
const SPEAKER_COLORS = [
  "var(--state-info-fg)",
  "var(--state-success-fg)",
  "var(--state-warning-fg)",
  "var(--primary)",
  "var(--state-error-fg)",
  "var(--muted-foreground)",
];

export interface TranscriptQuote {
  speaker: string;
  time: string;
  text: string;
}

export function TranscriptPanel({
  workspaceId,
  noteId,
  onQuote,
  onClose,
}: {
  workspaceId: string;
  noteId: string;
  /** Puts a line into the note, as a quote. */
  onQuote: (quote: TranscriptQuote) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("notes");
  const file = useTranscriptsStore((s) => s.byNote[transcriptKey(workspaceId, noteId)]);
  const recordingHere = useRecorderStore(
    (s) => s.phase !== "idle" && s.workspaceId === workspaceId && s.noteId === noteId,
  );
  const liveId = useRecorderStore((s) => (recordingHere ? s.recordingId : null));
  const partial = useRecorderStore((s) => (recordingHere ? s.partial : null));
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  useEffect(() => {
    void loadTranscript(workspaceId, noteId).then(() => resumeSecondPasses(workspaceId, noteId));
  }, [workspaceId, noteId]);

  // While it records, the newest words stay in view (unless scrolled up to read).
  const lineCount = file?.recordings.reduce((n, r) => n + r.lines.length, 0) ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: new words (lineCount, partial) scroll it
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [lineCount, partial]);

  const recordings = file?.recordings ?? [];
  // Names used in this note, offered when naming a voice.
  const names = useMemo(
    () =>
      [
        ...new Set(recordings.flatMap((r) => Object.values(r.speakers).map((n) => n.trim()))),
      ].filter(Boolean),
    [recordings],
  );

  return (
    <aside
      className={cn(
        "flex h-[45%] min-h-0 shrink-0 flex-col border-t border-border",
        "@min-[720px]/note:h-auto @min-[720px]/note:w-[340px] @min-[720px]/note:border-t-0 @min-[720px]/note:border-l",
      )}
      aria-label={t("transcript.title")}
      data-testid="note-transcript"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-app-ui-sm font-medium text-foreground">{t("transcript.title")}</span>
        <button
          type="button"
          className="ml-auto inline-flex size-6 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          onClick={onClose}
          aria-label={t("transcript.hide")}
          title={t("transcript.hide")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {file === undefined ? null : recordings.length === 0 ? (
          <p className="px-1 py-6 text-center text-app-ui-sm text-muted-foreground">
            {t("transcript.empty")}
          </p>
        ) : (
          recordings.map((r) => (
            <RecordingView
              key={r.id}
              workspaceId={workspaceId}
              noteId={noteId}
              recording={r}
              live={r.id === liveId}
              partial={r.id === liveId ? partial : null}
              names={names}
              onQuote={onQuote}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function RecordingView({
  workspaceId,
  noteId,
  recording,
  live,
  partial,
  names,
  onQuote,
}: {
  workspaceId: string;
  noteId: string;
  recording: TranscriptRecording;
  live: boolean;
  partial: { speaker: string; text: string } | null;
  names: string[];
  onQuote: (quote: TranscriptQuote) => void;
}) {
  const { t, i18n } = useTranslation("notes");
  const refining = useSecondPassStore((s) => Boolean(s.running[recording.id]));
  const voices = speakersOf(recording);
  if (partial && !voices.includes(partial.speaker)) voices.push(partial.speaker);
  // Voices given one name are one person: one chip, one color.
  const personOf = (key: string) => recording.speakers[key]?.trim() || `#${key}`;
  const people = [...new Set(voices.map(personOf))].map((person) => ({
    person,
    keys: voices.filter((k) => personOf(k) === person),
  }));
  const colorOf = (key: string) =>
    SPEAKER_COLORS[people.findIndex((p) => p.person === personOf(key)) % SPEAKER_COLORS.length];
  const unnamed = (key: string) => t("transcript.speaker", { label: key });
  const nameOf = (key: string) => speakerName(recording, key, unnamed);
  const lines = joinedLines(recording.lines);
  const refined = recording.takes.length > 0 && recording.takes.every((tk) => tk.pass === "done");
  const startedAt = dateTimeFormat(i18n.language || "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(recording.startedAt));

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
    <section className="mb-4" data-testid="transcript-recording">
      <div className="flex items-center gap-1.5 py-1 text-app-micro text-muted-foreground">
        <span className="truncate">
          {startedAt} · {clockOf(recordingMs(recording))}
        </span>
        {live ? (
          <span className="shrink-0 text-[var(--state-error-fg)]">{t("transcript.live")}</span>
        ) : refining ? (
          <span className="flex shrink-0 items-center gap-1">
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
      {people.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1.5">
          {people.map(({ person, keys }) => (
            <SpeakerChip
              key={person}
              name={nameOf(keys[0] as string)}
              named={!person.startsWith("#")}
              color={colorOf(keys[0] as string)}
              names={names}
              onName={(name) => {
                for (const key of keys) nameSpeaker(workspaceId, noteId, recording.id, key, name);
              }}
            />
          ))}
        </div>
      )}
      {lines.length === 0 && !partial && (
        <p className="py-1 text-app-ui-sm text-muted-foreground">
          {live ? t("transcript.listening") : t("transcript.nothing")}
        </p>
      )}
      <ol className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <Line
            key={`${line.speaker}-${line.startMs}`}
            line={line}
            name={nameOf(line.speaker)}
            color={colorOf(line.speaker)}
            onQuote={() =>
              onQuote({
                speaker: nameOf(line.speaker),
                time: clockOf(line.startMs),
                text: line.text,
              })
            }
          />
        ))}
        {partial && (
          <li className="text-app-ui-sm leading-5 text-muted-foreground italic">
            <span
              className="mr-1.5 font-medium not-italic"
              style={{ color: colorOf(partial.speaker) }}
            >
              {nameOf(partial.speaker)}
            </span>
            {partial.text}
          </li>
        )}
      </ol>
    </section>
  );
}

function Line({
  line,
  name,
  color,
  onQuote,
}: {
  line: TranscriptLine;
  name: string;
  color: string | undefined;
  onQuote: () => void;
}) {
  const { t } = useTranslation("notes");
  return (
    <li
      className="group relative text-app-ui-sm leading-5 text-foreground"
      data-testid="transcript-line"
    >
      <span className="mr-1.5 text-app-micro text-muted-foreground tabular-nums">
        {clockOf(line.startMs)}
      </span>
      <span className="mr-1.5 font-medium" style={{ color }}>
        {name}
      </span>
      {line.text}
      <button
        type="button"
        className="absolute top-0 right-0 hidden size-5 items-center justify-center rounded-(--radius-control) border border-border bg-popover text-muted-foreground group-hover:inline-flex hover:text-foreground"
        onClick={onQuote}
        aria-label={t("transcript.insert")}
        title={t("transcript.insert")}
      >
        <Plus className="size-3" />
      </button>
    </li>
  );
}

function SpeakerChip({
  name,
  named,
  color,
  names,
  onName,
}: {
  name: string;
  named: boolean;
  color: string | undefined;
  names: string[];
  onName: (name: string) => void;
}) {
  const { t } = useTranslation("notes");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const listId = useMemo(() => `note-speaker-names-${Math.random().toString(36).slice(2)}`, []);
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
            if (e.key === "Enter") done(true);
            else if (e.key === "Escape") done(false);
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
    <button
      type="button"
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-(--radius-pill) border px-2 text-app-micro hover:bg-[var(--state-hover-bg)]",
        named
          ? "border-border text-foreground"
          : "border-dashed border-border text-muted-foreground",
      )}
      onClick={() => {
        setValue(named ? name : "");
        setEditing(true);
      }}
      title={t("transcript.rename")}
      data-testid="speaker-chip"
    >
      <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
      {name}
    </button>
  );
}
