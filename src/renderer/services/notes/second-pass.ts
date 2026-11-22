/**
 * A recording's second pass: each take's file goes once more to the server,
 * whole, for a more accurate text and voices. Its lines are replaced by what
 * comes back (the names given carry over by time), and the server is told
 * to drop the file and the text. A pass under way is kept in the transcript
 * (the take's transcriptionId), so it is picked up again when the note is
 * opened after the app was closed.
 */
import i18next from "i18next";
import { create } from "zustand";
import { isLongEnoughToSummarize } from "../../../shared/notes/summary";
import { type TranscriptRecording, withSecondPass } from "../../../shared/notes/transcript";
import type { TranscribeResult } from "../../../shared/remote/voice";
import { showToast } from "../../components/ui/toast";
import { ipcCallResult } from "../../ipc/client";
import { useNoteSummarySettings } from "../../state/stores/note-summary";
import { notesApi } from "./api";
import {
  flushTranscript,
  loadTranscript,
  transcriptKey,
  updateRecording,
  useTranscriptsStore,
} from "./transcripts";

/** How often a pass under way is asked after. */
export const POLL_MS = 4000;
/** How long the pass waits before a summary can use the saved transcript so far. */
export const GIVE_UP_MS = 45 * 60_000;

/** The recordings whose second pass runs, by id. */
export const useSecondPassStore = create<{ running: Record<string, true> }>(() => ({
  running: {},
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingOf(workspaceId: string, noteId: string, recordingId: string) {
  return useTranscriptsStore
    .getState()
    .byNote[transcriptKey(workspaceId, noteId)]?.recordings.find((r) => r.id === recordingId);
}

function setTake(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  index: number,
  change: Record<string, unknown>,
  drop: string[] = [],
): void {
  updateRecording(workspaceId, noteId, recordingId, (r) => ({
    ...r,
    takes: r.takes.map((t, i) => {
      if (i !== index) return t;
      const next: Record<string, unknown> = { ...t, ...change };
      for (const k of drop) delete next[k];
      return next as typeof t;
    }),
  }));
}

function tell(reason: Extract<TranscribeResult, { status: "failed" }>["reason"] | "failed"): void {
  showToast({ kind: "error", message: i18next.t(`notes:transcript.passFailed.${reason}`) });
}

/** Whether a recording has a take that can still go for a second pass, or one under way. */
export function canSecondPass(recording: {
  takes: readonly { token?: string; pass: string }[];
}): boolean {
  return recording.takes.some((t) => (t.pass === "none" && t.token) || t.pass === "pending");
}

/** Finishes a recording's second pass, if needed, then requests its automatic summary. */
export async function runSecondPass(
  workspaceId: string,
  noteId: string,
  recordingId: string,
  refine = true,
): Promise<void> {
  if (useSecondPassStore.getState().running[recordingId]) return;
  useSecondPassStore.setState((s) => ({ running: { ...s.running, [recordingId]: true } }));
  try {
    await loadTranscript(workspaceId, noteId);
    await flushTranscript(workspaceId, noteId, false, true);
    const recording = recordingOf(workspaceId, noteId, recordingId);
    if (!recording) return;
    let told = false;
    for (const [index, take] of recording.takes.entries()) {
      if (!refine || take.pass !== "none" || !take.token) continue;
      const sent = await ipcCallResult("remote", "voiceTranscribe", {
        workspaceId,
        noteId,
        file: take.file,
        token: take.token,
        language: recording.language,
      });
      const result: TranscribeResult = sent.ok
        ? sent.value
        : { status: "failed", reason: "failed", message: sent.message };
      if (result.status === "submitted") {
        setTake(
          workspaceId,
          noteId,
          recordingId,
          index,
          {
            pass: "pending",
            transcriptionId: result.id,
          },
          ["token"],
        );
      } else {
        // A used or old token is no good again; anything else (over the month's
        // minutes, too many passes under way, no network) may be tried again.
        const spent = result.reason === "expired" || result.reason === "too-big";
        setTake(
          workspaceId,
          noteId,
          recordingId,
          index,
          spent ? { pass: "error" } : {},
          spent ? ["token"] : [],
        );
        if (!told) tell(result.reason);
        told = true;
      }
    }
    await flushTranscript(workspaceId, noteId, false, true);
    const result = await waitForPasses(workspaceId, noteId, recordingId);
    const latest = recordingOf(workspaceId, noteId, recordingId);
    if (!result || !latest || !useNoteSummarySettings.getState().enabled) return;
    if (result === "complete" && latest.takes.some((take) => take.pass === "pending")) return;
    if (!isLongEnoughToSummarize(latest)) return;
    await flushTranscript(workspaceId, noteId, false, true);
    // Another window can finish the same persisted pass. Main admits only one run.
    await notesApi.summarize(workspaceId, noteId, recordingId, "auto").catch(() => {
      showToast({ kind: "error", message: i18next.t("notes:summary.actionFailed") });
    });
  } catch {
    // flushTranscript already reports failed writes. Do not summarize unsaved text.
  } finally {
    useSecondPassStore.setState((s) => {
      const { [recordingId]: _done, ...rest } = s.running;
      return { running: rest };
    });
  }
}

async function waitForPasses(
  workspaceId: string,
  noteId: string,
  recordingId: string,
): Promise<"complete" | "timed-out" | undefined> {
  const until = Date.now() + GIVE_UP_MS;
  let told = false;
  while (Date.now() < until) {
    const recording = recordingOf(workspaceId, noteId, recordingId);
    if (!recording) return;
    const pending = recording.takes
      .map((t, index) => ({ t, index }))
      .filter(({ t }) => t.pass === "pending" && t.transcriptionId);
    if (!pending.length) return "complete";
    for (const { t, index } of pending) {
      const id = t.transcriptionId as string;
      const asked = await ipcCallResult("remote", "voiceTranscription", { id });
      if (!asked.ok) {
        // Gone from the server (a day passed, or the account went): it cannot come now.
        if (asked.kind === "not-found") {
          setTake(workspaceId, noteId, recordingId, index, { pass: "error" }, ["transcriptionId"]);
          if (!told) tell("expired");
          told = true;
        }
        continue;
      }
      const transcription = asked.value;
      if (transcription.status === "pending") continue;
      let before: TranscriptRecording | undefined;
      let applied: TranscriptRecording | undefined;
      updateRecording(workspaceId, noteId, recordingId, (r) => {
        const take = r.takes[index];
        if (!take || take.transcriptionId !== id || take.pass !== "pending") return r;
        before = r;
        const next =
          transcription.status === "done" ? withSecondPass(r, index, transcription.segments) : r;
        const done = next !== r;
        applied = {
          ...next,
          takes: next.takes.map((tk, i) => {
            if (i !== index) return tk;
            const { transcriptionId: _id, ...rest } = tk;
            return { ...rest, pass: done ? "done" : "error" };
          }),
        };
        return applied;
      });
      if (!before || !applied) continue;
      if (applied.takes[index]?.pass === "error" && !told) {
        tell("failed");
        told = true;
      }
      const previous = before;
      const completed = applied;
      try {
        await flushTranscript(workspaceId, noteId, true, true);
      } catch {
        // Keep the job available for another attempt. Preserve edits made during the write.
        updateRecording(workspaceId, noteId, recordingId, (r) => {
          if (r === completed) return previous;
          if (r.takes[index] !== completed.takes[index]) return r;
          return {
            ...r,
            takes: r.takes.map((tk, i) => (i === index ? (previous.takes[index] ?? tk) : tk)),
          };
        });
        return;
      }
      // The text is here: the server and its provider can let the file and the text go.
      void ipcCallResult("remote", "voiceTranscriptionDrop", { id });
    }
    const current = recordingOf(workspaceId, noteId, recordingId);
    if (!current?.takes.some((take) => take.pass === "pending" && take.transcriptionId))
      return "complete";
    await sleep(POLL_MS);
  }
  return "timed-out";
}

/** Picks up the passes of a note's recordings left under way (the app was closed meanwhile). */
export async function resumeSecondPasses(workspaceId: string, noteId: string): Promise<void> {
  const file = await loadTranscript(workspaceId, noteId);
  for (const r of file.recordings) {
    if (r.takes.some((t) => t.pass === "pending" && t.transcriptionId))
      void runSecondPass(workspaceId, noteId, r.id);
  }
}
