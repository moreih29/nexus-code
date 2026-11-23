import { linesDiffComputers } from "monaco-editor/esm/vs/editor/common/diff/linesDiffComputers";
import { mapChangesToDirty } from "./map";
import type { DirtyChange } from "./types";

const MAX_COMPUTATION_TIME_MS = 1000;

const computer = linesDiffComputers.getDefault();

function toLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function computeDirtyChanges(
  originalText: string,
  modifiedText: string,
  ignoreTrimWhitespace = true,
): DirtyChange[] {
  if (originalText === modifiedText) return [];

  const result = computer.computeDiff(toLines(originalText), toLines(modifiedText), {
    computeMoves: false,
    ignoreTrimWhitespace,
    maxComputationTimeMs: MAX_COMPUTATION_TIME_MS,
  });

  return mapChangesToDirty(result.changes);
}
