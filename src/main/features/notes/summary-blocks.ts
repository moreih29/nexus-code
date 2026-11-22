import type { DocNode } from "../../../shared/notes/markdown";
import { summaryOrigin } from "../../../shared/notes/summary";
import { clockOf, recordingMs, type TranscriptRecording } from "../../../shared/notes/transcript";
import { type SummaryLanguage, type SummaryOutput, summarySpeakers } from "./summary-text";

function textBlock(type: "heading" | "paragraph", text: string): DocNode {
  return {
    type,
    ...(type === "heading" ? { attrs: { level: 3 } } : {}),
    content: [{ type: "text", text }],
  };
}

export function summaryBlocks(
  recording: TranscriptRecording,
  output: SummaryOutput,
  language: SummaryLanguage,
): DocNode[] {
  const ko = language === "ko";
  const date = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(recording.startedAt);
  const header = `${ko ? "녹음" : "Recording"} · ${date} · ${clockOf(recordingMs(recording))}`;
  const blocks: DocNode[] = [textBlock("paragraph", header)];
  if (output.summary.length) {
    blocks.push(textBlock("heading", ko ? "요약" : "Summary"), {
      type: "bulletList",
      content: output.summary.map((text) => ({
        type: "listItem",
        content: [textBlock("paragraph", text)],
      })),
    });
  }
  if (output.todos.length) {
    const speakers = new Map(
      summarySpeakers(recording, language).map(({ key, name }) => [key, name]),
    );
    const timestamps = new Set(recording.lines.map(({ startMs }) => Math.round(startMs)));
    blocks.push(textBlock("heading", ko ? "할 일" : "To-dos"), {
      type: "taskList",
      content: output.todos.map(({ text, speaker, atMs }) => ({
        type: "taskItem",
        attrs: {
          checked: false,
          nexusSpeaker: speaker ? (speakers.get(speaker) ?? null) : null,
          nexusAt: atMs !== null && timestamps.has(atMs) ? atMs : null,
        },
        content: [textBlock("paragraph", text)],
      })),
    });
  }
  const nexusOrigin = summaryOrigin(recording.id);
  return blocks.map((block) => ({ ...block, attrs: { ...block.attrs, nexusOrigin } }));
}
