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
import { isLongEnoughToSummarize } from "../../../shared/notes/summary";
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
  type RecordingSummaries,
  summarizeSavedRecording,
} from "../../services/notes/use-summaries";
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
import { useNoteSummarySettings } from "../../state/stores/note-summary";
import { useUIStore } from "../../state/stores/ui";
import { Button } from "../ui/button";
import { showConfirmDialog } from "../ui/confirm-dialog";
import type { DropdownMenuPoint } from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { consentToVoiceMemory, SpeakerNameDialog } from "./speaker-name-dialog";
import { type SummaryTaskTimes, summaryTaskRows } from "./summary-task-times";
import { LineMoveMenu, LineRow, type LineTarget, PartialRow } from "./transcript-line";
import { PickedSpeaker, RecordingAftercare, RecordingHeading } from "./transcript-recording";
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
  type TranscriptJump,
  type TranscriptRow,
  transcriptJumpKey,
  transcriptRows,
} from "./transcript-rows";
import { NOTE_TEXT_MIN, TranscriptSash } from "./transcript-sash";

export interface TranscriptQuote {
  speaker: string;
  time: string;
  text: string;
}

const NO_RECORDINGS: readonly TranscriptRecording[] = [];

const STUCK_PX = 40;

const LIT_MS = 1600;

interface Moving {
  readonly recordingId: string;
  readonly line: TranscriptLine;
  readonly point: DropdownMenuPoint;
}

export const TranscriptPanel = memo(function TranscriptPanel({
  workspaceId,
  noteId,
  summaries,
  taskTimes,
  flushNote,
  onQuote,
  onClose,
  jump,
}: {
  workspaceId: string;
  noteId: string;
  summaries: RecordingSummaries;
  taskTimes: SummaryTaskTimes;
  flushNote: () => Promise<boolean>;
  onQuote: (quote: TranscriptQuote) => void;
  onClose: () => void;
  jump?: TranscriptJump;
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
  const latest = recordings.at(-1);
  const summaryOn = useNoteSummarySettings((s) => s.enabled);
  const summaryNext =
    latest !== undefined &&
    summaryOn &&
    summaries[latest.id] === undefined &&
    isLongEnoughToSummarize(latest);
  const read = useMemo(() => readRecordings(recordings), [recordings]);
  const taskRows = useMemo(() => summaryTaskRows(read, taskTimes), [read, taskTimes]);
  const rerun = useCallback(
    async (recordingId: string) => {
      const confirmed = await showConfirmDialog({
        title: t("summary.rerun"),
        description: t("summary.rerunConfirm"),
        confirmLabel: t("summary.rerun"),
      });
      if (!confirmed) return;
      try {
        if (!(await flushNote())) throw new Error("Note save failed");
        await summarizeSavedRecording(workspaceId, noteId, recordingId, "rerun");
      } catch {
        showToast({ kind: "error", message: t("summary.actionFailed") });
      }
    },
    [flushNote, noteId, t, workspaceId],
  );
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
  const names = useMemo(
    () =>
      [
        ...new Set(recordings.flatMap((r) => Object.values(r.speakers).map((n) => n.trim()))),
      ].filter(Boolean),
    [recordings],
  );
  const unnamed = useCallback((key: string) => t("transcript.speaker", { label: key }), [t]);

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

  const stuck = useRef(true);
  const wholeTop = useRef<{ key: string; into: number } | null>(null);
  const wholeAt = useRef<{ top: typeof wholeTop.current; stuck: boolean } | null>(null);
  const wasNarrowed = useRef(false);
  const [reveal, setReveal] = useState<{ key: string }>();
  const handled = useRef<typeof reveal>(undefined);
  const [lit, setLit] = useState<string | null>(null);
  const viewKey = `${speaker?.recordingId ?? ""}\n${speaker?.person ?? ""}\n${query.trim()}`;
  const live = liveId !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs as the view changes
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (reveal && handled.current !== reveal) {
      handled.current = reveal;
      wholeAt.current = null;
      wasNarrowed.current = false;
      stuck.current = false;
      const index = rows.findIndex((row) => row.key === reveal.key);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
      el.focus({ preventScroll: true });
      return;
    }
    if (narrowed) {
      if (!wasNarrowed.current) wholeAt.current = { top: wholeTop.current, stuck: stuck.current };
      wasNarrowed.current = true;
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
    el.scrollTop = row && top ? row.start + top.into : 0;
  }, [viewKey, reveal]);

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
    setReveal({ key });
    setSpeaker(null);
    setQuery("");
    setSearching(false);
    setLit(key);
  }, []);

  const lastJump = useRef<TranscriptJump | undefined>(undefined);
  useEffect(() => {
    if (!jump || jump === lastJump.current) return;
    const key = transcriptJumpKey(read, jump);
    if (!key) return;
    lastJump.current = jump;
    showInWhole(key);
  }, [jump, read, showInWhole]);

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
      {latest && latest.id !== liveId && (
        <RecordingAftercare
          workspaceId={workspaceId}
          noteId={noteId}
          recording={latest}
          summaryNext={summaryNext}
        />
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
                    latest={row.recording.id === latest?.id}
                    first={item.index === 0}
                    picked={speaker}
                    suggestions={suggestions.get(row.recording.id) ?? NO_VOICE_SUGGESTIONS}
                    narrowed={narrowed}
                    lit={lit === row.key}
                    summaryTask={taskRows.has(row.key)}
                    summarizing={summaries[row.recording.id]?.state === "running"}
                    onRerun={rerun}
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

function Row({
  row,
  cast,
  workspaceId,
  noteId,
  live,
  latest,
  first,
  picked,
  suggestions,
  narrowed,
  lit,
  summaryTask,
  summarizing,
  onRerun,
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
  latest: boolean;
  first: boolean;
  picked: SpeakerFilter | null;
  suggestions: readonly VoiceNameSuggestion[];
  narrowed: boolean;
  lit: boolean;
  summaryTask: boolean;
  summarizing: boolean;
  onRerun: (recordingId: string) => void;
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
          promptAbove={latest}
          summarizing={summarizing}
          onRerun={onRerun}
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
          summaryTask={summaryTask}
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
