/**
 * A recording's heading in the transcript: when it was made and how long it
 * runs, how far its second pass is, its menu, and its people. A person's
 * chip shows only what they said (and back to everyone, clicked again); the
 * pencil in a picked chip names them, which names each of their voices.
 * The person picked is also shown above the lines (`PickedSpeaker`), where
 * it stays as the recording scrolls away.
 */
import {
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
import { memo, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { dateTimeFormat } from "@/utils/intl-format";
import {
  clockOf,
  peopleIn,
  protectedVoiceCount,
  recordingMs,
  shouldPromptSpeakerCount,
  speakerName,
  type TranscriptRecording,
} from "../../../shared/notes/transcript";
import { regroupKey, regroupRecording, useRegroupStore } from "../../services/notes/regroup";
import { canSecondPass, runSecondPass, useSecondPassStore } from "../../services/notes/second-pass";
import { removeRecording, updateRecording } from "../../services/notes/transcripts";
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
import { RegroupDialog } from "./regroup-dialog";
import type { LineTarget } from "./transcript-line";
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
  onMerge,
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
  onMerge: (recordingId: string, from: string, to: string) => void;
}) {
  const { t, i18n } = useTranslation("notes");
  const refining = useSecondPassStore((s) => Boolean(s.running[recording.id]));
  const progress = useRegroupStore(
    (s) => s.progress[regroupKey(workspaceId, noteId, recording.id)],
  );
  const voicePrint = useVoicePrintAvailable();
  const [regroupOpen, setRegroupOpen] = useState(false);
  const refined = recording.takes.length > 0 && recording.takes.every((tk) => tk.pass === "done");
  const startedAt = dateTimeFormat(i18n.language || "en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(recording.startedAt));
  const unnamed = (key: string) => t("transcript.speaker", { label: key });
  const choices = cast.people.map(({ keys, color }) => ({
    key: keys[0] as string,
    name: speakerName(recording, keys[0] as string, unnamed),
    color: speakerColor(color),
  }));
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
  const prompt = !live && !regroupReason && shouldPromptSpeakerCount(recording);
  const regroup = (count: number) => {
    setRegroupOpen(false);
    void regroupRecording(workspaceId, noteId, recording.id, count);
  };

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
        ) : progress !== undefined ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap" role="status">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("transcript.regroup.progress", { percent: progress })}
          </span>
        ) : refining ? (
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Loader2 className="size-3 animate-spin" aria-hidden="true" />
            {t("transcript.refining")}
          </span>
        ) : refined ? (
          <span className="shrink-0">{t("transcript.refined")}</span>
        ) : null}
        {recording.participantCount !== undefined && recording.participantCount !== "auto" && (
          <span className="shrink-0 whitespace-nowrap">
            {recording.participantCount === "7+"
              ? t("transcript.participantsMany")
              : t("transcript.participants", { count: recording.participantCount })}
          </span>
        )}
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
                disabled={Boolean(regroupReason)}
                onSelect={() => setRegroupOpen(true)}
              >
                <span className="flex items-center gap-2">
                  <Layers2 className="size-3.5" aria-hidden="true" />
                  {t("transcript.regroup.menu")}
                </span>
              </DropdownMenuItem>
              {regroupReason && <DropdownMenuText muted>{regroupReason}</DropdownMenuText>}
              {!recording.audioRemoved && (
                <DropdownMenuItem
                  disabled={progress !== undefined}
                  onSelect={() => void removeRecording(workspaceId, noteId, recording.id, false)}
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
      </div>
      {prompt && (
        <div className="mb-2 flex flex-col gap-1.5 rounded-(--radius-control) border border-[var(--state-warning-border)] bg-[var(--state-warning-bg)] px-2 py-1.5">
          <p className="text-app-ui-sm text-[var(--state-warning-fg)]">
            {t("transcript.regroup.prompt", { count: peopleIn(recording) })}
          </p>
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
                  onClick={() => regroup(count)}
                >
                  {count}
                </Button>
              ))}
            <Button
              size="sm"
              type="button"
              variant="outline"
              className="h-6 px-2"
              onClick={() => setRegroupOpen(true)}
            >
              {t("transcript.regroup.custom")}
            </Button>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              className="ml-auto h-6 px-2"
              onClick={() =>
                updateRecording(workspaceId, noteId, recording.id, (r) => ({
                  ...r,
                  speakerPromptDismissed: true,
                }))
              }
            >
              {t("common:action.close")}
            </Button>
          </div>
        </div>
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
          {cast.people.map(({ person, keys, color }) => (
            <SpeakerChip
              key={person}
              name={speakerName(recording, keys[0] as string, unnamed)}
              named={isNamed(person)}
              color={speakerColor(color)}
              picked={picked === person}
              names={names}
              mergeTargets={choices.filter((choice) => choice.key !== keys[0])}
              onPick={() => onPick(recording.id, person)}
              onName={(name) => onName(recording.id, keys, name)}
              onMerge={(to) => onMerge(recording.id, keys[0] as string, to)}
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
  mergeTargets,
  onPick,
  onName,
  onMerge,
}: {
  name: string;
  named: boolean;
  color: string;
  picked: boolean;
  names: readonly string[];
  mergeTargets: readonly LineTarget[];
  onPick: () => void;
  onName: (name: string) => void;
  onMerge: (to: string) => void;
}) {
  const { t } = useTranslation("notes");
  const ViewIcon = picked ? Users : Eye;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const listId = useId();
  const edit = () => {
    setValue(named ? name : "");
    setEditing(true);
  };
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
        className="inline-flex h-full items-center gap-1.5 rounded-(--radius-pill) pr-1 pl-2 hover:bg-[var(--state-hover-bg)]"
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
          onClick={edit}
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
          <DropdownMenuItem onSelect={edit}>
            <span className="flex items-center gap-2">
              <Pencil className="size-3.5" aria-hidden="true" />
              {t("transcript.rename")}
            </span>
          </DropdownMenuItem>
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
