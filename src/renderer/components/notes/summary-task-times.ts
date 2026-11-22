import type { DocNode } from "../../../shared/notes/markdown";
import { RECORDING_ID_RE } from "../../../shared/notes/transcript";
import { lineKey, type ReadRecording } from "./transcript-rows";

export type SummaryTaskTimes = ReadonlyMap<string, ReadonlySet<number>>;

/** The source times of tasks still in the note, scoped to their recording. */
export function summaryTaskTimes(doc: DocNode): SummaryTaskTimes {
  const byRecording = new Map<string, Set<number>>();
  const collect = (node: DocNode, times: Set<number>) => {
    const at = node.attrs?.nexusAt;
    if (node.type === "taskItem" && typeof at === "number" && Number.isInteger(at) && at >= 0)
      times.add(at);
    for (const child of node.content ?? []) collect(child, times);
  };
  for (const block of doc.content ?? []) {
    const origin = block.attrs?.nexusOrigin;
    if (block.type !== "taskList" || typeof origin !== "string" || !origin.startsWith("summary:"))
      continue;
    const id = origin.slice("summary:".length);
    if (!RECORDING_ID_RE.test(id)) continue;
    const times = byRecording.get(id) ?? new Set<number>();
    collect(block, times);
    if (times.size) byRecording.set(id, times);
  }
  return byRecording;
}

export function sameSummaryTaskTimes(a: SummaryTaskTimes, b: SummaryTaskTimes): boolean {
  if (a.size !== b.size) return false;
  for (const [id, times] of a) {
    const next = b.get(id);
    if (!next || times.size !== next.size || [...times].some((at) => !next.has(at))) return false;
  }
  return true;
}

/** A source segment can be inside a joined row, after the time the row displays. */
export function summaryTaskRows(
  read: readonly ReadRecording[],
  byRecording: SummaryTaskTimes,
): Set<string> {
  const rows = new Set<string>();
  for (const { recording, lines } of read) {
    const times = byRecording.get(recording.id);
    if (!times) continue;
    for (const at of times) {
      const source = recording.lines.find((line) => Math.round(line.startMs) === at);
      if (!source) continue;
      const shown = lines.find(
        (line) =>
          line.speaker === source.speaker &&
          line.startMs <= source.startMs &&
          source.startMs <= line.endMs,
      );
      if (shown) rows.add(lineKey(recording.id, shown));
    }
  }
  return rows;
}
