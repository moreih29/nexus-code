/**
 * The note's recording controls, in its header: "Record" while nothing is
 * recorded; while this note is, the time so far with Pause (or Resume) and
 * Stop. Another note's recording leaves the button off: one at a time.
 */
import { Loader2, Mic, Pause, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/utils/cn";
import { clockOf } from "../../../shared/notes/transcript";
import {
  pauseRecording,
  recorderElapsedMs,
  resumeRecording,
  startRecording,
  stopRecording,
  useRecorderStore,
} from "../../services/notes/recorder";
import { useVoiceAvailability, voiceLanguage } from "../../services/voice/availability";
import { tellFailure } from "../../services/voice/dictation";

const BUTTON =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-(--radius-control) border border-border px-2.5 text-app-ui-sm text-foreground hover:bg-[var(--state-hover-bg)] disabled:pointer-events-none disabled:opacity-50";
const ICON_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-(--radius-control) text-muted-foreground hover:bg-[var(--state-hover-bg)] hover:text-foreground";

/** The time so far, ticking while it records. */
function useElapsed(): number {
  const state = useRecorderStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.takeSince) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [state.takeSince]);
  return recorderElapsedMs(state, Math.max(now, state.takeSince ?? 0));
}

export function RecordControls({
  workspaceId,
  noteId,
  onStart,
}: {
  workspaceId: string;
  noteId: string;
  /** A recording started here: the transcript shows. */
  onStart: () => void;
}) {
  const { t } = useTranslation("notes");
  const phase = useRecorderStore((s) => s.phase);
  const here = useRecorderStore((s) => s.workspaceId === workspaceId && s.noteId === noteId);
  const level = useRecorderStore((s) => s.level);
  const availability = useVoiceAvailability();
  const elapsed = useElapsed();

  if (phase === "idle" || !here) {
    const elsewhere = phase !== "idle";
    return (
      <button
        type="button"
        className={BUTTON}
        disabled={elsewhere || availability === "unavailable"}
        title={
          elsewhere
            ? t("recorder.elsewhere")
            : availability === "unavailable"
              ? t("recorder.unavailable")
              : t("recorder.recordHint")
        }
        onClick={() => {
          if (availability === "signed-out") {
            tellFailure("signed-out");
            return;
          }
          onStart();
          void startRecording(workspaceId, noteId, voiceLanguage());
        }}
        data-testid="note-record"
      >
        <Mic className="size-3.5" aria-hidden="true" />
        {t("recorder.record")}
      </button>
    );
  }

  const busy = phase === "starting" || phase === "pausing" || phase === "stopping";
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-0.5 rounded-(--radius-control) border border-border pr-0.5 pl-2"
      data-testid="note-recorder"
      data-phase={phase}
    >
      {busy ? (
        <Loader2 className="size-3 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : (
        <span
          className={cn(
            "size-2 rounded-full",
            phase === "recording" ? "bg-[var(--state-error-fg)]" : "bg-muted-foreground",
          )}
          style={phase === "recording" ? { opacity: 0.55 + Math.min(0.45, level) } : undefined}
          aria-hidden="true"
        />
      )}
      <span className="ml-1 min-w-11 text-app-ui-sm tabular-nums text-foreground" aria-live="off">
        {clockOf(elapsed)}
      </span>
      <span className="mr-1 text-app-micro text-muted-foreground">
        {phase === "starting"
          ? t("recorder.starting")
          : phase === "stopping" || phase === "pausing"
            ? t("recorder.stopping")
            : phase === "paused"
              ? t("recorder.paused")
              : t("recorder.recording")}
      </span>
      {phase === "paused" ? (
        <button
          type="button"
          className={ICON_BUTTON}
          onClick={() => void resumeRecording()}
          aria-label={t("recorder.resume")}
          title={t("recorder.resume")}
          data-testid="note-record-resume"
        >
          <Mic className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          className={ICON_BUTTON}
          disabled={phase !== "recording"}
          onClick={pauseRecording}
          aria-label={t("recorder.pause")}
          title={t("recorder.pause")}
          data-testid="note-record-pause"
        >
          <Pause className="size-3.5" />
        </button>
      )}
      <button
        type="button"
        className={ICON_BUTTON}
        disabled={phase !== "recording" && phase !== "paused"}
        onClick={stopRecording}
        aria-label={t("recorder.stop")}
        title={t("recorder.stop")}
        data-testid="note-record-stop"
      >
        <Square className="size-3" />
      </button>
    </div>
  );
}
