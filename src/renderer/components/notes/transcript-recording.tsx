import {
  Check,
  Ear,
  Eye,
  Layers2,
  Loader2,
  Merge,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { dateTimeFormat } from "@/utils/intl-format";
import { isLongEnoughToSummarize } from "../../../shared/notes/summary";
import {
  clockOf,
  peopleIn,
  protectedVoiceCount,
  recordingMs,
  shouldPromptSpeakerCount,
  speakerName,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import type { VoiceNameSuggestion } from "../../../shared/notes/voice-names";
import { regroupKey, regroupRecording, useRegroupStore } from "../../services/notes/regroup";
import {
  canSecondPass,
  runSecondPass,
  summarizeIfSettled,
  useSecondPassStore,
} from "../../services/notes/second-pass";
import { removeRecording, updateRecording } from "../../services/notes/transcripts";
import {
  canSuggestNames,
  clearVoiceSuggestions,
  rejectVoiceSuggestion,
  searchVoiceSuggestions,
  useVoiceMemory,
  voiceSuggestionKey,
} from "../../services/notes/voice-memory";
import { useVoicePrintAvailable } from "../../services/notes/voice-print";
import { Button } from "../ui/button";
import { showConfirmDialog } from "../ui/confirm-dialog";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRoot,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuText,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { showToast } from "../ui/toast";
import { RegroupDialog } from "./regroup-dialog";
import type { LineTarget } from "./transcript-line";
import { type Cast, isNamed, speakerColor } from "./transcript-rows";

function RecordingLine({
  recording,
  lengthMs,
  children,
}: {
  recording: TranscriptRecording;
  lengthMs?: number;
  children?: ReactNode;
}) {
  const { i18n } = useTranslation("notes");
  const startedAt = dateTimeFormat(i18n.language || "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(recording.startedAt));
  return (
    <div className="flex min-h-8 items-center gap-1.5 py-1 text-app-micro text-muted-foreground">
      <span className="truncate">
        {startedAt} · {clockOf(Math.max(lengthMs ?? 0, recordingMs(recording)))}
      </span>
      {children}
    </div>
  );
}

function Participants({ recording }: { recording: TranscriptRecording }) {
  const { t } = useTranslation("notes");
  if (recording.participantCount === undefined || recording.participantCount === "auto")
    return null;
  return (
    <span className="shrink-0 whitespace-nowrap">
      {recording.participantCount === "7+"
        ? t("transcript.participantsMany")
        : t("transcript.participants", { count: recording.participantCount })}
    </span>
  );
}

export const RecordingHeadingView = memo(function RecordingHeadingView({
  recording,
  cast,
  first,
  picked,
  lengthMs,
  onPick,
}: {
  recording: TranscriptRecording;
  cast: Cast;
  first: boolean;
  picked: string | null;
  lengthMs?: number;
  onPick: (recordingId: string, person: string) => void;
}) {
  const { t } = useTranslation("notes");
  const unnamed = (key: string) => t("transcript.speaker", { label: key });
  return (
    <div className={cn(!first && "pt-2.5")} data-testid="transcript-recording">
      <RecordingLine recording={recording} lengthMs={lengthMs}>
        <Participants recording={recording} />
      </RecordingLine>
      {cast.people.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cast.people.map(({ person, keys, color }) => (
            <SpeakerChip
              key={person}
              name={speakerName(recording, keys[0] as string, unnamed)}
              named={isNamed(person)}
              color={speakerColor(color)}
              picked={picked === person}
              onPick={() => onPick(recording.id, person)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

export const RecordingHeading = memo(function RecordingHeading({
  workspaceId,
  noteId,
  recording,
  cast,
  live,
  summarizing,
  onRerun,
  first,
  picked,
  suggestions,
  onPick,
  onRename,
  onAccept,
  onMerge,
  promptAbove,
}: {
  workspaceId: string;
  noteId: string;
  recording: TranscriptRecording;
  cast: Cast;
  live: boolean;
  promptAbove: boolean;
  summarizing: boolean;
  onRerun: (recordingId: string) => void;
  first: boolean;
  picked: string | null;
  suggestions: readonly VoiceNameSuggestion[];
  onPick: (recordingId: string, person: string) => void;
  onRename: (recordingId: string, keys: readonly string[]) => void;
  onAccept: (recordingId: string, suggestions: readonly VoiceNameSuggestion[]) => void;
  onMerge: (recordingId: string, from: string, to: string) => void;
}) {
  const { t } = useTranslation("notes");
  const ref = { workspaceId, noteId, recordingId: recording.id };
  const memoryStatus = useVoiceMemory((s) => s.status);
  const searching = useVoiceMemory((s) => s.searching[voiceSuggestionKey(ref)]);
  const { refining, progress, regroupReason } = useRecordingWork(workspaceId, noteId, recording);
  const [regroupOpen, setRegroupOpen] = useState(false);
  const refined = recording.takes.length > 0 && recording.takes.every((tk) => tk.pass === "done");
  const unnamed = (key: string) => t("transcript.speaker", { label: key });
  const choices = cast.people.map(({ keys, color }) => ({
    key: keys[0] as string,
    name: speakerName(recording, keys[0] as string, unnamed),
    color: speakerColor(color),
  }));
  const prompt = !live && !promptAbove && !regroupReason && shouldPromptSpeakerCount(recording);
  const regroup = (count: number) => {
    setRegroupOpen(false);
    void regroupRecording(workspaceId, noteId, recording.id, count);
  };

  const findNames = async () => {
    const result = await searchVoiceSuggestions(ref);
    if (result === "empty") showToast({ kind: "info", message: t("voiceMemory.noMatch") });
    if (result === "failed" || result === "unavailable") {
      showToast({ kind: "error", message: t("voiceMemory.findFailed") });
    }
  };

  const remove = async (text: boolean) => {
    clearVoiceSuggestions(ref);
    await removeRecording(workspaceId, noteId, recording.id, text);
  };

  const removeAll = async () => {
    const ok = await showConfirmDialog({
      title: t("transcript.removeConfirm.title"),
      description: t("transcript.removeConfirm.description"),
      confirmLabel: t("transcript.removeConfirm.confirm"),
      variant: "destructive",
    });
    if (ok) await remove(true);
  };

  return (
    <div className={cn(!first && "pt-2.5")} data-testid="transcript-recording">
      <RecordingLine recording={recording}>
        {live ? (
          <span className="shrink-0 whitespace-nowrap text-[var(--state-error-fg)]">
            {t("transcript.live")}
          </span>
        ) : progress !== undefined ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("transcript.regroup.progress", { percent: progress })}
          </span>
        ) : searching ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("voiceMemory.finding")}
          </span>
        ) : refining ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("transcript.refining")}
          </span>
        ) : refined ? (
          <span className="shrink-0">{t("transcript.refined")}</span>
        ) : null}
        <Participants recording={recording} />
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
                  disabled={progress !== undefined}
                  onSelect={() => void runSecondPass(workspaceId, noteId, recording.id)}
                >
                  <span className="flex items-center gap-2">
                    <Sparkles className="size-3.5" aria-hidden="true" />
                    {t("transcript.refine")}
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={
                  summarizing ||
                  refining ||
                  progress !== undefined ||
                  !isLongEnoughToSummarize(recording)
                }
                onSelect={() => onRerun(recording.id)}
              >
                <span className="flex items-center gap-2">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  {t("summary.rerun")}
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={Boolean(regroupReason)}
                onSelect={() => setRegroupOpen(true)}
              >
                <span className="flex items-center gap-2">
                  <Layers2 className="size-3.5" aria-hidden="true" />
                  {t("transcript.regroup.menu")}
                </span>
              </DropdownMenuItem>
              {memoryStatus?.available && memoryStatus.suggest && (
                <DropdownMenuItem
                  disabled={Boolean(regroupReason || searching) || !canSuggestNames(memoryStatus)}
                  onSelect={() => void findNames()}
                >
                  <span className="flex items-center gap-2">
                    <Ear className="size-3.5" aria-hidden="true" />
                    {t("voiceMemory.find")}
                  </span>
                </DropdownMenuItem>
              )}
              {regroupReason && <DropdownMenuText muted>{regroupReason}</DropdownMenuText>}
              {!recording.audioRemoved && (
                <DropdownMenuItem
                  disabled={progress !== undefined}
                  onSelect={() => void remove(false)}
                >
                  <span className="flex items-center gap-2">
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    {t("transcript.removeAudio")}
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled={progress !== undefined} onSelect={() => void removeAll()}>
                <span className="flex items-center gap-2">
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {t("transcript.removeAll")}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuRoot>
        )}
      </RecordingLine>
      {prompt && (
        <SpeakerCountPrompt
          workspaceId={workspaceId}
          noteId={noteId}
          recording={recording}
          summaryNext={false}
          className="mb-2"
        />
      )}
      {regroupOpen && !regroupReason && (
        <RegroupDialog
          recording={recording}
          onRegroup={regroup}
          onClose={() => setRegroupOpen(false)}
        />
      )}
      {cast.people.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cast.people.map(({ person, keys, color }) => {
            const key = keys[0] as string;
            const suggestion = suggestions.find((s) => s.key === key);
            return (
              <SpeakerChip
                key={person}
                name={speakerName(recording, key, unnamed)}
                named={isNamed(person)}
                color={speakerColor(color)}
                picked={picked === person}
                suggestion={suggestion?.name}
                mergeTargets={choices.filter((choice) => choice.key !== key)}
                onPick={() => onPick(recording.id, person)}
                onRename={() => onRename(recording.id, keys)}
                onAccept={suggestion ? () => onAccept(recording.id, [suggestion]) : undefined}
                onReject={
                  suggestion ? () => void rejectVoiceSuggestion(ref, suggestion) : undefined
                }
                onMerge={(to) => onMerge(recording.id, key, to)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});

function useRecordingWork(workspaceId: string, noteId: string, recording: TranscriptRecording) {
  const { t } = useTranslation("notes");
  const refining = useSecondPassStore((s) => Boolean(s.running[recording.id]));
  const progress = useRegroupStore(
    (s) => s.progress[regroupKey(workspaceId, noteId, recording.id)],
  );
  const voicePrint = useVoicePrintAvailable();
  const regroupReason =
    recording.audioRemoved || recording.takes.length === 0
      ? t("transcript.regroup.audioMissing")
      : !voicePrint
        ? t("transcript.regroup.modelUnavailable")
        : refining || progress !== undefined
          ? t("transcript.regroup.busy")
          : !recording.lines.length
            ? t("transcript.regroup.noSpeech")
            : null;
  return { refining, progress, regroupReason };
}

export function SpeakerCountPrompt({
  workspaceId,
  noteId,
  recording,
  summaryNext,
  className,
}: {
  workspaceId: string;
  noteId: string;
  recording: TranscriptRecording;
  summaryNext: boolean;
  className?: string;
}) {
  const { t } = useTranslation("notes");
  const [open, setOpen] = useState(false);
  const settle = () => {
    if (summaryNext) void summarizeIfSettled(workspaceId, noteId, recording.id);
  };
  const regroup = async (count: number) => {
    setOpen(false);
    await regroupRecording(workspaceId, noteId, recording.id, count);
    settle();
  };
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-(--radius-control) border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1.5",
        className,
      )}
      data-testid="speaker-count-prompt"
    >
      <p className="text-app-ui-sm text-[var(--state-warning-fg)]">
        {t("transcript.regroup.prompt", { count: peopleIn(recording) })}
      </p>
      {summaryNext && (
        <p className="text-app-micro text-muted-foreground">{t("transcript.after.summaryWaits")}</p>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {[2, 3, 4, 5, 6]
          .filter((count) => count >= protectedVoiceCount(recording))
          .map((count) => (
            <Button
              key={count}
              size="sm"
              type="button"
              variant="outline"
              className="h-6 px-2"
              onClick={() => void regroup(count)}
            >
              {count}
            </Button>
          ))}
        <Button
          size="sm"
          type="button"
          variant="outline"
          className="h-6 px-2"
          onClick={() => setOpen(true)}
        >
          {t("transcript.regroup.custom")}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="ml-auto h-6 px-2"
          onClick={() => {
            updateRecording(workspaceId, noteId, recording.id, (r) => ({
              ...r,
              speakerPromptDismissed: true,
            }));
            settle();
          }}
        >
          {t("common:action.close")}
        </Button>
      </div>
      {open && (
        <RegroupDialog
          recording={recording}
          onRegroup={(count) => void regroup(count)}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

export function RecordingAftercare({
  workspaceId,
  noteId,
  recording,
  summaryNext,
}: {
  workspaceId: string;
  noteId: string;
  recording: TranscriptRecording;
  summaryNext: boolean;
}) {
  const { t } = useTranslation("notes");
  const { refining, progress, regroupReason } = useRecordingWork(workspaceId, noteId, recording);
  if (refining || progress !== undefined) {
    return (
      <p
        className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-app-ui-sm text-muted-foreground"
        role="status"
        data-testid="recording-aftercare"
      >
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        <span className="min-w-0 truncate">
          {progress !== undefined
            ? t("transcript.regroup.progress", { percent: progress })
            : t("transcript.refining")}
          {summaryNext && ` · ${t("transcript.after.thenSummary")}`}
        </span>
      </p>
    );
  }
  if (regroupReason || !shouldPromptSpeakerCount(recording)) return null;
  return (
    <div className="shrink-0 border-b border-border px-3 py-2" data-testid="recording-aftercare">
      <SpeakerCountPrompt
        workspaceId={workspaceId}
        noteId={noteId}
        recording={recording}
        summaryNext={summaryNext}
      />
    </div>
  );
}

function SpeakerChip({
  name,
  named,
  color,
  picked,
  suggestion,
  mergeTargets,
  onPick,
  onRename,
  onAccept,
  onReject,
  onMerge,
}: {
  name: string;
  named: boolean;
  color: string;
  picked: boolean;
  suggestion?: string;
  mergeTargets?: readonly LineTarget[];
  onPick: () => void;
  onRename?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onMerge?: (to: string) => void;
}) {
  const { t } = useTranslation("notes");
  const ViewIcon = picked ? Users : Eye;
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
        className="inline-flex h-full items-center gap-1.5 rounded-(--radius-pill) pr-1 pl-2 hover:bg-[var(--state-hover-bg)]"
        onClick={onPick}
        title={picked ? t("transcript.everyone") : t("transcript.only")}
        data-testid="speaker-chip"
      >
        <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden="true" />
        {name}
        {suggestion && (
          <span className="text-muted-foreground">
            · {t("voiceMemory.suggestion", { name: suggestion })}
          </span>
        )}
      </button>
      {suggestion && (
        <>
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-(--radius-pill) text-[var(--state-success-fg)] hover:bg-[var(--state-hover-bg)]"
            aria-label={t("voiceMemory.accept", { name: suggestion })}
            title={t("voiceMemory.accept", { name: suggestion })}
            onClick={onAccept}
          >
            <Check className="size-3" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-(--radius-pill) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
            aria-label={t("voiceMemory.reject", { name: suggestion })}
            title={t("voiceMemory.reject", { name: suggestion })}
            onClick={onReject}
          >
            <X className="size-3" aria-hidden="true" />
          </button>
        </>
      )}
      {picked && onRename && (
        <button
          type="button"
          className="mr-0.5 inline-flex size-5 items-center justify-center rounded-(--radius-pill) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
          onClick={onRename}
          aria-label={t("transcript.rename")}
          title={t("transcript.rename")}
          data-testid="speaker-chip-rename"
        >
          <Pencil className="size-3" aria-hidden="true" />
        </button>
      )}
      <DropdownMenuRoot>
        <DropdownMenuTrigger>
          <button
            type="button"
            className="mr-0.5 inline-flex size-5 items-center justify-center rounded-(--radius-pill) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground"
            aria-label={t("transcript.speakerOptions", { name })}
            title={t("transcript.speakerOptions", { name })}
          >
            <MoreHorizontal className="size-3" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {onRename && (
            <DropdownMenuItem onSelect={onRename}>
              <span className="flex items-center gap-2">
                <Pencil className="size-3.5" aria-hidden="true" />
                {t("transcript.rename")}
              </span>
            </DropdownMenuItem>
          )}
          {onMerge && mergeTargets && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={!mergeTargets.length}>
                <span className="flex items-center gap-2">
                  <Merge className="size-3.5" aria-hidden="true" />
                  {t("transcript.mergeSpeaker")}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {mergeTargets.map((target) => (
                  <DropdownMenuItem key={target.key} onSelect={() => onMerge(target.key)}>
                    <span className="flex items-center gap-2">
                      <span
                        className="size-1.5 rounded-full"
                        style={{ background: target.color }}
                        aria-hidden="true"
                      />
                      {target.name}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          <DropdownMenuItem onSelect={onPick}>
            <span className="flex items-center gap-2">
              <ViewIcon className="size-3.5" aria-hidden="true" />
              {picked ? t("transcript.everyone") : t("transcript.only")}
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuRoot>
    </span>
  );
}

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
