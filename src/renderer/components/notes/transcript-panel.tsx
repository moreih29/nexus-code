/**
 * A note's transcript, beside its text: each recording with its people and
 * what they said, a time to a line. While this note records, the words
 * come in as they are said. A person's chip shows only what they said
 * (shown above the lines too, which takes it back to everyone), and its
 * pencil names them (the name goes to each of their voices); a search
 * shows the lines with its words; a line's time, while either holds, shows
 * that line in the whole conversation. A line is moved to another voice by
 * clicking its speaker, and goes into the note as a quote; a recording of
 * more than one person is heard again, whole, once it ends. The line
 * between it and the text is dragged to give either more room.
 *
 * Only the lines in sight are drawn (a meeting of hours has thousands), and
 * the panel is drawn again only for its own changes, not the note's.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search, X } from "lucide-react";
import {
  type CSSProperties,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import {
  clockOf,
  newSpeakerKey,
  type SpeakerMoveScope,
  speakerName,
  type TranscriptLine,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import type { VoiceNameSuggestion } from "../../../shared/notes/voice-names";
import { liveVoiceNameSamples, moveLine, useRecorderStore } from "../../services/notes/recorder";
import { resumeSecondPasses } from "../../services/notes/second-pass";
import {
  loadTranscript,
  nameSpeaker,
  transcriptKey,
  useTranscriptsStore,
} from "../../services/notes/transcripts";
import {
  currentVoiceSuggestions,
  dismissVoiceSuggestions,
  hasVoiceAudio,
  loadVoiceMemory,
  NO_VOICE_SUGGESTIONS,
  rememberNamedVoice,
  useVoiceMemory,
  visibleVoiceSuggestions,
  voiceSuggestionKey,
} from "../../services/notes/voice-memory";
import { useUIStore } from "../../state/stores/ui";
import { Button } from "../ui/button";
import type { DropdownMenuPoint } from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { consentToVoiceMemory, SpeakerNameDialog } from "./speaker-name-dialog";
import { LineMoveMenu, LineRow, type LineTarget, PartialRow } from "./transcript-line";
import { PickedSpeaker, RecordingHeading } from "./transcript-recording";
import {
  type Cast,
  castOf,
  isNamed,
  isNarrowed,
  isPicked,
  personOf,
  readRecordings,
  type SpeakerFilter,
  speakerColor,
  type TranscriptRow,
  transcriptRows,
} from "./transcript-rows";
import { NOTE_TEXT_MIN, TranscriptSash } from "./transcript-sash";

export interface TranscriptQuote {
  speaker: string;
  time: string;
  text: string;
}

const NO_RECORDINGS: readonly TranscriptRecording[] = [];

/** Within this of the end, the transcript follows new words. */
const STUCK_PX = 40;

/** How long a line shown in the whole conversation stays lit. */
const LIT_MS = 1600;

/** A line being moved to another voice, and where its menu opens. */
interface Moving {
  readonly recordingId: string;
  readonly line: TranscriptLine;
  readonly point: DropdownMenuPoint;
}

export const TranscriptPanel = memo(function TranscriptPanel({
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
  const panel = useRef<HTMLElement>(null);
  const width = useUIStore((s) => s.noteTranscriptWidth);
  const share = useUIStore((s) => s.noteTranscriptShare);

  useEffect(() => {
    void loadVoiceMemory();
    void loadTranscript(workspaceId, noteId).then(() => resumeSecondPasses(workspaceId, noteId));
  }, [workspaceId, noteId]);

  const recordings = file?.recordings ?? NO_RECORDINGS;
  const read = useMemo(() => readRecordings(recordings), [recordings]);
  const offered = useVoiceMemory((s) => s.byRecording);
  const suggestions = useMemo(
    () =>
      new Map(
        recordings.map((recording) => [
          recording.id,
          visibleVoiceSuggestions(
            recording,
            offered[voiceSuggestionKey({ workspaceId, noteId, recordingId: recording.id })],
          ),
        ]),
      ),
    [workspaceId, noteId, recordings, offered],
  );
  const bulkSuggestions = useMemo(
    () =>
      new Set(
        Array.from(suggestions)
          .filter(([, list]) => list.length > 1)
          .map(([id]) => id),
      ),
    [suggestions],
  );
  const partialSpeaker = partial?.speaker ?? null;
  const casts = useMemo(
    () =>
      new Map(recordings.map((r) => [r.id, castOf(r, r.id === liveId ? partialSpeaker : null)])),
    [recordings, liveId, partialSpeaker],
  );
  // Names used in this note, offered when naming a person.
  const names = useMemo(
    () =>
      [
        ...new Set(recordings.flatMap((r) => Object.values(r.speakers).map((n) => n.trim()))),
      ].filter(Boolean),
    [recordings],
  );
  const unnamed = useCallback((key: string) => t("transcript.speaker", { label: key }), [t]);

  // What the transcript is narrowed to.
  const [speaker, setSpeaker] = useState<SpeakerFilter | null>(null);
  const [naming, setNaming] = useState<{ recordingId: string; keys: readonly string[] } | null>(
    null,
  );
  const namingRecording = naming ? recordings.find((r) => r.id === naming.recordingId) : undefined;
  const namingKey = naming?.keys[0];
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const view = useMemo(() => ({ speaker, query }), [speaker, query]);
  const narrowed = isNarrowed(view);
  const { rows, matches } = useMemo(
    () => transcriptRows(read, view, { recordingId: liveId, partial }, bulkSuggestions),
    [read, view, liveId, partial, bulkSuggestions],
  );

  useEffect(() => {
    if (searching) searchRef.current?.focus();
  }, [searching]);

  const closeSearch = useCallback(() => {
    setSearching(false);
    setQuery("");
    searchToggleRef.current?.focus();
  }, []);

  // The person picked, as their chip names them: shown above the lines, which
  // the recording's chips scroll away from.
  const alone = useMemo(() => {
    if (!speaker) return null;
    const recording = recordings.find((r) => r.id === speaker.recordingId);
    const p = casts.get(speaker.recordingId)?.people.find((x) => x.person === speaker.person);
    if (recording && p) {
      return {
        name: speakerName(recording, p.keys[0] as string, unnamed),
        color: speakerColor(p.color),
      };
    }
    // Gone from its recording (its voices grouped again): still the way back.
    const { person } = speaker;
    return { name: isNamed(person) ? person : unnamed(person.slice(1)), color: null };
  }, [speaker, recordings, casts, unnamed]);

  const pick = useCallback((recordingId: string, person: string) => {
    setSpeaker((now) => (isPicked(now, recordingId, person) ? null : { recordingId, person }));
  }, []);

  const name = useCallback(
    (recordingId: string, keys: readonly string[], value: string, remember: boolean) => {
      const recordingNow = () =>
        useTranscriptsStore
          .getState()
          .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recordingId);
      const first = keys[0];
      const before = recordingNow();
      if (!before || first === undefined) return;
      const was = personOf(before, first);
      const ref = { workspaceId, noteId, recordingId };
      const confirmed = value.trim().slice(0, 80);
      if (confirmed) dismissVoiceSuggestions(ref, keys);
      for (const key of keys) nameSpeaker(workspaceId, noteId, recordingId, key, confirmed);
      // The person picked, named, stays picked under their name.
      const after = recordingNow();
      if (!after) return;
      const is = personOf(after, first);
      setSpeaker((now) => (isPicked(now, recordingId, was) ? { recordingId, person: is } : now));
      if (remember && confirmed && hasVoiceAudio(after)) {
        void consentToVoiceMemory()
          .then(
            (status) =>
              status &&
              rememberNamedVoice(ref, keys, confirmed, status, () => liveVoiceNameSamples(ref)),
          )
          .catch(() => showToast({ kind: "error", message: t("voiceMemory.saveFailed") }));
      }
    },
    [workspaceId, noteId, t],
  );

  const rename = useCallback((recordingId: string, keys: readonly string[]) => {
    setNaming({ recordingId, keys });
  }, []);

  const accept = useCallback(
    (recordingId: string, offered: readonly VoiceNameSuggestion[]) => {
      const current = currentVoiceSuggestions({ workspaceId, noteId, recordingId });
      for (const suggestion of offered) {
        if (current.some((s) => s.key === suggestion.key && s.name === suggestion.name)) {
          name(recordingId, [suggestion.key], suggestion.name, true);
        }
      }
    },
    [workspaceId, noteId, name],
  );

  // Scrolling: only the rows in sight are drawn.
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]?.kind === "recording" ? 64 : 46),
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 10,
    paddingStart: 8,
    paddingEnd: 8,
  });

  // Following the newest words: while it records and the end is in sight,
  // the transcript stays at its end (unless scrolled up to read).
  const stuck = useRef(true);
  // The row at the top of the whole transcript, and how far into it it is
  // scrolled: where to go back to once a narrowing is taken back. By row,
  // since rows not yet drawn change their height once they are.
  const wholeTop = useRef<{ key: string; into: number } | null>(null);
  const wholeAt = useRef<{ top: typeof wholeTop.current; stuck: boolean } | null>(null);
  const wasNarrowed = useRef(false);
  // A line to bring into sight once the whole transcript shows again.
  const reveal = useRef<string | null>(null);
  const [lit, setLit] = useState<string | null>(null);
  const viewKey = `${speaker?.recordingId ?? ""}\n${speaker?.person ?? ""}\n${query.trim()}`;
  const live = liveId !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the view changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = reveal.current;
    reveal.current = null;
    if (target !== null) {
      wholeAt.current = null;
      wasNarrowed.current = false;
      stuck.current = false;
      const index = rows.findIndex((row) => row.key === target);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
      // The time clicked is gone with the narrowing; the keyboard stays here.
      el.focus({ preventScroll: true });
      return;
    }
    if (narrowed) {
      if (!wasNarrowed.current) wholeAt.current = { top: wholeTop.current, stuck: stuck.current };
      wasNarrowed.current = true;
      // A narrowed view reads from its start, but goes on following the
      // words coming in as they come.
      if (!(live && stuck.current)) {
        stuck.current = false;
        el.scrollTop = 0;
      }
      return;
    }
    if (!wasNarrowed.current) return;
    wasNarrowed.current = false;
    const at = wholeAt.current;
    wholeAt.current = null;
    if (!at) return;
    stuck.current = at.stuck;
    if (at.stuck) return;
    const { top } = at;
    const row = top && virtualizer.measurementsCache[rows.findIndex((r) => r.key === top.key)];
    // Not scrolled before it was narrowed: it was at its start.
    el.scrollTop = row && top ? row.start + top.into : 0;
  }, [viewKey]);

  const total = virtualizer.getTotalSize();
  // biome-ignore lint/correctness/useExhaustiveDependencies: new rows and their sizes move the end
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [total, rows]);

  useEffect(() => {
    if (lit === null) return;
    const timer = setTimeout(() => setLit(null), LIT_MS);
    return () => clearTimeout(timer);
  }, [lit]);

  const showInWhole = useCallback((key: string) => {
    reveal.current = key;
    setSpeaker(null);
    setQuery("");
    setSearching(false);
    setLit(key);
  }, []);

  // The handlers rows are given stay the same; they read what is current here.
  const current = useRef({ casts, recordings, unnamed, onQuote });
  current.current = { casts, recordings, unnamed, onQuote };

  const quote = useCallback((recordingId: string, line: TranscriptLine) => {
    const { recordings: all, unnamed: label, onQuote: put } = current.current;
    const recording = all.find((r) => r.id === recordingId);
    if (!recording) return;
    put({
      speaker: speakerName(recording, line.speaker, label),
      time: clockOf(line.startMs),
      text: line.text,
    });
  }, []);

  const [moving, setMoving] = useState<Moving | null>(null);
  const openMove = useCallback(
    (recordingId: string, line: TranscriptLine, point: DropdownMenuPoint) =>
      setMoving({ recordingId, line, point }),
    [],
  );
  const closeMove = useCallback(() => setMoving(null), []);
  const moveTargets = useMemo((): LineTarget[] => {
    if (!moving) return [];
    const recording = recordings.find((r) => r.id === moving.recordingId);
    const cast = casts.get(moving.recordingId);
    if (!recording || !cast) return [];
    const own = cast.personOf(moving.line.speaker);
    return cast.people
      .filter((p) => p.person !== own)
      .map((p) => ({
        key: p.keys[0] as string,
        name: speakerName(recording, p.keys[0] as string, unnamed),
        color: speakerColor(p.color),
      }));
  }, [moving, recordings, casts, unnamed]);
  const applyMove = useCallback(
    (recording: TranscriptRecording, line: TranscriptLine, to: string, scope: SpeakerMoveScope) => {
      moveLine(workspaceId, noteId, recording.id, line, to, scope);
      if (scope !== "all") return;
      const updated = useTranscriptsStore
        .getState()
        .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recording.id);
      if (!updated || updated === recording) return;
      const source = personOf(recording, line.speaker);
      const target = personOf(recording, to);
      setSpeaker((now) =>
        now?.recordingId === recording.id && (now.person === source || now.person === target)
          ? { recordingId: recording.id, person: personOf(updated, to) }
          : now,
      );
    },
    [workspaceId, noteId],
  );
  const move = useCallback(
    (to: string | null, scope: SpeakerMoveScope) => {
      if (!moving) return;
      const recording = current.current.recordings.find((r) => r.id === moving.recordingId);
      if (recording) applyMove(recording, moving.line, to ?? newSpeakerKey(recording), scope);
    },
    [moving, applyMove],
  );
  const merge = useCallback(
    (recordingId: string, from: string, to: string) => {
      const recording = current.current.recordings.find((r) => r.id === recordingId);
      const line = recording?.lines.find((l) => l.speaker === from);
      if (recording && line) applyMove(recording, line, to, "all");
    },
    [applyMove],
  );

  // Escape takes back the narrowing: the person picked, then the search.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (speaker) setSpeaker(null);
    else if (searching) closeSearch();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <aside
      ref={panel}
      className={cn(
        "relative flex h-(--transcript-share) min-h-0 shrink-0 flex-col border-t border-border",
        "@min-[720px]/note:h-auto @min-[720px]/note:w-(--transcript-width) @min-[720px]/note:max-w-[calc(100%-var(--note-text-min))] @min-[720px]/note:border-t-0 @min-[720px]/note:border-l",
      )}
      style={
        {
          "--transcript-share": `${share * 100}%`,
          "--transcript-width": `${width}px`,
          "--note-text-min": `${NOTE_TEXT_MIN}px`,
        } as CSSProperties
      }
      aria-label={t("transcript.title")}
      data-testid="note-transcript"
      onKeyDown={onKeyDown}
    >
      <TranscriptSash beside panel={panel} />
      <TranscriptSash beside={false} panel={panel} />
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3">
        <span className="shrink-0 whitespace-nowrap text-app-ui-sm font-medium text-foreground">
          {t("transcript.title")}
        </span>
        <div className="mr-auto flex min-w-0 pl-1">
          {alone && (
            <PickedSpeaker
              name={alone.name}
              color={alone.color}
              onClear={() => {
                setSpeaker(null);
                // The chip goes; the keyboard stays in the transcript.
                scroller.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </div>
        {recordings.length > 0 && (
          <button
            ref={searchToggleRef}
            type="button"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground aria-pressed:bg-[var(--state-active-bg)] aria-pressed:text-foreground"
            onClick={() => (searching ? closeSearch() : setSearching(true))}
            aria-label={t("transcript.search")}
            aria-pressed={searching}
            title={t("transcript.search")}
            data-testid="transcript-search-toggle"
          >
            <Search className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          onClick={onClose}
          aria-label={t("transcript.hide")}
          title={t("transcript.hide")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {searching && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.stopPropagation();
              if (query) setQuery("");
              else if (speaker) setSpeaker(null);
              else closeSearch();
            }}
            placeholder={t("transcript.searchPlaceholder")}
            aria-label={t("transcript.search")}
            className="h-7 min-w-0 flex-1 rounded-(--radius-control) border border-border bg-transparent px-2 text-app-ui-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            data-testid="transcript-search"
          />
          {query.trim() && (
            <span
              className="shrink-0 text-app-micro text-muted-foreground tabular-nums"
              aria-live="polite"
              data-testid="transcript-search-count"
            >
              {matches}
            </span>
          )}
        </div>
      )}
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto outline-none"
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STUCK_PX;
          if (!narrowed) {
            const top = virtualizer.getVirtualItems().find((item) => item.end > el.scrollTop);
            wholeTop.current = top
              ? { key: String(top.key), into: el.scrollTop - top.start }
              : null;
          }
        }}
      >
        {file === undefined ? null : recordings.length === 0 ? (
          <p className="px-4 py-8 text-center text-app-ui-sm text-muted-foreground">
            {t("transcript.empty")}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: total }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index] as TranscriptRow;
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className="absolute top-0 left-0 w-full px-3 pb-1.5"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <Row
                    row={row}
                    cast={casts.get(row.recording.id) as Cast}
                    workspaceId={workspaceId}
                    noteId={noteId}
                    live={row.recording.id === liveId}
                    first={item.index === 0}
                    picked={speaker}
                    suggestions={suggestions.get(row.recording.id) ?? NO_VOICE_SUGGESTIONS}
                    narrowed={narrowed}
                    lit={lit === row.key}
                    unnamed={unnamed}
                    onPick={pick}
                    onRename={rename}
                    onAccept={accept}
                    onMerge={merge}
                    onSpeaker={openMove}
                    onQuote={quote}
                    onShowInWhole={showInWhole}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {naming && namingRecording && namingKey && (
        <SpeakerNameDialog
          speaker={speakerName(namingRecording, namingKey, unnamed)}
          initial={namingRecording.speakers[namingKey] ?? ""}
          names={names}
          workspaceId={workspaceId}
          noteId={noteId}
          takes={namingRecording.takes}
          audioRemoved={namingRecording.audioRemoved === true}
          onSave={(value, remember) => {
            setNaming(null);
            name(naming.recordingId, naming.keys, value, remember);
          }}
          onClose={() => setNaming(null)}
        />
      )}
      <LineMoveMenu
        point={moving?.point ?? null}
        targets={moveTargets}
        onMove={move}
        onClose={closeMove}
      />
    </aside>
  );
});

/** One row of the transcript, as its kind draws it. */
function Row({
  row,
  cast,
  workspaceId,
  noteId,
  live,
  first,
  picked,
  suggestions,
  narrowed,
  lit,
  unnamed,
  onPick,
  onRename,
  onAccept,
  onMerge,
  onSpeaker,
  onQuote,
  onShowInWhole,
}: {
  row: TranscriptRow;
  cast: Cast;
  workspaceId: string;
  noteId: string;
  live: boolean;
  first: boolean;
  picked: SpeakerFilter | null;
  suggestions: readonly VoiceNameSuggestion[];
  narrowed: boolean;
  lit: boolean;
  unnamed: (key: string) => string;
  onPick: (recordingId: string, person: string) => void;
  onRename: (recordingId: string, keys: readonly string[]) => void;
  onAccept: (recordingId: string, suggestions: readonly VoiceNameSuggestion[]) => void;
  onMerge: (recordingId: string, from: string, to: string) => void;
  onSpeaker: (recordingId: string, line: TranscriptLine, point: DropdownMenuPoint) => void;
  onQuote: (recordingId: string, line: TranscriptLine) => void;
  onShowInWhole: (rowKey: string) => void;
}) {
  const { t } = useTranslation("notes");
  const { recording } = row;
  switch (row.kind) {
    case "recording": {
      const person =
        picked && cast.people.find((p) => isPicked(picked, recording.id, p.person))?.person;
      return (
        <RecordingHeading
          workspaceId={workspaceId}
          noteId={noteId}
          recording={recording}
          cast={cast}
          live={live}
          first={first}
          picked={person || null}
          suggestions={suggestions}
          onPick={onPick}
          onRename={onRename}
          onAccept={onAccept}
          onMerge={onMerge}
        />
      );
    }
    case "line": {
      const suggestion = suggestions.find((s) => s.key === row.line.speaker);
      return (
        <LineRow
          rowKey={row.key}
          recordingId={recording.id}
          line={row.line}
          name={
            suggestion
              ? t("voiceMemory.suggestion", { name: suggestion.name })
              : speakerName(recording, row.line.speaker, unnamed)
          }
          suggested={suggestion !== undefined}
          color={speakerColor(cast.colorOf(row.line.speaker))}
          marks={row.marks}
          narrowed={narrowed}
          lit={lit}
          onSpeaker={onSpeaker}
          onQuote={onQuote}
          onShowInWhole={onShowInWhole}
        />
      );
    }
    case "partial": {
      const suggestion = suggestions.find((s) => s.key === row.speaker);
      return (
        <PartialRow
          name={
            suggestion
              ? t("voiceMemory.suggestion", { name: suggestion.name })
              : speakerName(recording, row.speaker, unnamed)
          }
          suggested={suggestion !== undefined}
          color={speakerColor(cast.colorOf(row.speaker))}
          text={row.text}
          marks={row.marks}
        />
      );
    }
    case "accept-suggestions":
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAccept(recording.id, suggestions)}
        >
          {t("voiceMemory.acceptAll")}
        </Button>
      );
    case "quiet":
      return (
        <p className="py-1 text-app-ui-sm text-muted-foreground">
          {live ? t("transcript.listening") : t("transcript.nothing")}
        </p>
      );
  }
}
