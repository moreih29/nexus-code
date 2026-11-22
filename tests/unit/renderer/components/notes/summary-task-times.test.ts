import { expect, test } from "bun:test";
import {
  summaryTaskRows,
  summaryTaskTimes,
} from "../../../../../src/renderer/components/notes/summary-task-times";
import { readRecordings } from "../../../../../src/renderer/components/notes/transcript-rows";
import type { DocNode } from "../../../../../src/shared/notes/markdown";
import type { TranscriptRecording } from "../../../../../src/shared/notes/transcript";

test("marks a joined transcript row for its own recording while the summary task exists", () => {
  const recording: TranscriptRecording = {
    id: "r000000abcd",
    startedAt: 0,
    language: "en",
    lines: [
      { speaker: "1", startMs: 0, endMs: 500, text: "The next step" },
      { speaker: "1", startMs: 700, endMs: 1300, text: "Send the draft" },
    ],
    takes: [],
    speakers: {},
  };
  const taskList: DocNode = {
    type: "taskList",
    attrs: { nexusOrigin: `summary:${recording.id}` },
    content: [{ type: "taskItem", attrs: { nexusAt: 700 } }],
  };
  const read = readRecordings([recording, { ...recording, id: "r000000efgh" }]);
  expect([
    ...summaryTaskRows(read, summaryTaskTimes({ type: "doc", content: [taskList] })),
  ]).toEqual([`${recording.id}:1-0`]);
  expect(summaryTaskRows(read, summaryTaskTimes({ type: "doc" })).size).toBe(0);
});
