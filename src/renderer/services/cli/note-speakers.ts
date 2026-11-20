import type { CliUiOp } from "../../../shared/cli/ui";
import {
  newSpeakerKey,
  numberSpeakers,
  speakersOf,
  type TranscriptRecording,
  transcriptLinesForCli,
} from "../../../shared/notes/transcript";
import { voicePerson } from "../../../shared/notes/voices";
import { moveLine, moveRecordingLines, useRecorderStore } from "../notes/recorder";
import { regroupRecording } from "../notes/regroup";
import { flushTranscript, loadTranscript, nameSpeaker } from "../notes/transcripts";
import {
  currentVoiceSuggestions,
  dismissVoiceSuggestions,
  loadVoiceMemory,
  rejectVoiceSuggestion,
  searchVoiceSuggestions,
  voiceMemoryApi,
} from "../notes/voice-memory";
import { type CliUiHandler, UiRequestError } from "./handler";

type SpeakerOp = Extract<CliUiOp, "note.speakers" | "note.voiceSuggestions" | "note.voiceNames">;

async function recordingOf(workspaceId: string, noteId: string, selector?: string) {
  const file = await loadTranscript(workspaceId, noteId);
  const exact = file.recordings.find((recording) => recording.id === selector);
  if (exact) return exact;
  const matches =
    selector === undefined
      ? file.recordings
      : file.recordings.filter((recording) => recording.id.startsWith(selector));
  if (matches.length !== 1)
    throw new UiRequestError(
      matches.length ? "choose a recording with --recording" : "no recording found",
    );
  return matches[0] as TranscriptRecording;
}

function speakerOf(recording: TranscriptRecording, key: string) {
  if (!speakersOf(recording).includes(key))
    throw new UiRequestError(`no speaker "${key}"; use a speaker key from note transcript --json`);
  return key;
}

export const noteSpeakerHandlers: { [K in SpeakerOp]: CliUiHandler<K> } = {
  "note.speakers": async ({ workspaceId, noteId, recording: selector, change }) => {
    const recording = await recordingOf(workspaceId, noteId, selector);
    const recordingId = recording.id;
    switch (change.op) {
      case "rename": {
        const speaker = speakerOf(recording, change.speaker);
        const person = voicePerson(recording.speakers, speaker);
        const keys = speakersOf(recording).filter(
          (key) => voicePerson(recording.speakers, key) === person,
        );
        for (const key of keys) nameSpeaker(workspaceId, noteId, recordingId, key, change.name);
        dismissVoiceSuggestions({ workspaceId, noteId, recordingId }, keys);
        break;
      }
      case "merge": {
        const from = speakerOf(recording, change.from);
        const into = speakerOf(recording, change.into);
        const line = recording.lines.find((item) => item.speaker === from);
        if (!line) throw new UiRequestError("that voice has no lines");
        moveLine(workspaceId, noteId, recordingId, line, into, "all");
        break;
      }
      case "move": {
        const lines = transcriptLinesForCli(recording);
        const first = lines.findIndex((line) => line.id === change.first);
        const last = lines.findIndex((line) => line.id === change.last);
        if (first < 0 || last < first)
          throw new UiRequestError("give an ordered range of line ids from this recording");
        const into =
          change.into === "new" ? newSpeakerKey(recording) : speakerOf(recording, change.into);
        moveRecordingLines(workspaceId, noteId, recordingId, into, (current) =>
          numberSpeakers({
            ...current,
            lines: current.lines.map((line, index) =>
              index >= first && index <= last ? { ...line, speaker: into, pinned: true } : line,
            ),
          }),
        );
        break;
      }
      case "regroup": {
        const active = useRecorderStore.getState();
        if (
          active.workspaceId === workspaceId &&
          active.noteId === noteId &&
          active.phase !== "idle"
        )
          throw new UiRequestError("finish recording before regrouping speakers");
        await regroupRecording(workspaceId, noteId, recordingId, change.participants, true);
        return { recordingId };
      }
    }
    await flushTranscript(workspaceId, noteId, true, true);
    return { recordingId };
  },
  "note.voiceSuggestions": async ({ workspaceId, noteId, recording: selector, action }) => {
    const status = await loadVoiceMemory();
    if (status?.consent !== "allowed")
      throw new UiRequestError(
        "voice memory consent is off; the user can change it in Settings › Notes",
      );
    if (!status.available || !status.suggest)
      throw new UiRequestError("voice name suggestions are off or unavailable (Settings › Notes)");
    const recording = await recordingOf(workspaceId, noteId, selector);
    const recordingId = recording.id;
    const ref = { workspaceId, noteId, recordingId };
    let suggestions = currentVoiceSuggestions(ref);
    if (!suggestions.length && status.count > 0) {
      const search = await searchVoiceSuggestions(ref);
      if (search === "failed")
        throw new UiRequestError("could not search for voice name suggestions");
      suggestions = currentVoiceSuggestions(ref);
    }
    if (action.op !== "list") {
      const suggestion = suggestions.find(
        ({ key, name }) => key === action.speaker && name === action.name,
      );
      if (!suggestion) throw new UiRequestError("that suggestion is no longer available");
      if (action.op === "accept") {
        nameSpeaker(workspaceId, noteId, recordingId, suggestion.key, suggestion.name);
        dismissVoiceSuggestions(ref, [suggestion.key]);
        await flushTranscript(workspaceId, noteId, true, true);
      } else {
        await rejectVoiceSuggestion(ref, suggestion, true);
      }
    }
    return {
      recordingId,
      suggestions: currentVoiceSuggestions(ref).map(({ key, name }) => ({ speaker: key, name })),
    };
  },
  "note.voiceNames": async ({ action }) => {
    if (action.op === "delete") {
      if (action.name !== undefined) await voiceMemoryApi.remove(action.name);
      else await voiceMemoryApi.clear();
    }
    return { names: (await voiceMemoryApi.list()).map(({ name }) => name) };
  },
};
