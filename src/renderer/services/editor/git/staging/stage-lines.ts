import i18next from "i18next";
import { ipcCallResult, unwrapGitResult } from "../../../../ipc/client";
import { useGitStore } from "../../../../state/stores/git";
import { computeDirtyChanges } from "../dirty-diff/compute";
import {
  applyLineChanges,
  invertLineChange,
  type LineChange,
  type LineRange,
  lineChangeOfDirty,
  selectChanges,
  splitLines,
} from "./line-changes";

export interface StageLinesRequest {
  workspaceId: string;
  relPath: string;
  working: string;
  eol: string;
  ranges: readonly LineRange[];
}

export function stageLines(request: StageLinesRequest): Promise<void> {
  const { workspaceId, relPath, working, eol, ranges } = request;
  return serialized(workspaceId, relPath, () =>
    useGitStore.getState().stageContent(workspaceId, relPath, "stage", async (signal) => {
      const index = await readText(workspaceId, "INDEX", relPath, signal);
      if (index === null) return null;
      const picked = selectChanges(lineChanges(index.text, working), ranges);
      if (picked.length === 0) return null;
      return index.encode(applyLineChanges(index.text, splitLines(working).lines, picked, eol));
    }),
  );
}

export interface UnstageLinesRequest {
  workspaceId: string;
  relPath: string;
  headRelPath: string;
  index: string;
  ranges: readonly LineRange[];
}

export function unstageLines(request: UnstageLinesRequest): Promise<void> {
  const { workspaceId, relPath, headRelPath, ranges } = request;
  return serialized(workspaceId, relPath, () =>
    useGitStore.getState().stageContent(workspaceId, relPath, "unstage", async (signal) => {
      const [head, index] = await Promise.all([
        readText(workspaceId, "HEAD", headRelPath, signal),
        readText(workspaceId, "INDEX", relPath, signal),
      ]);
      if (head === null || index === null || index.text !== request.index) return null;
      const picked = selectChanges(lineChanges(head.text, index.text), ranges);
      if (picked.length === 0) return null;
      const { lines, breaks } = splitLines(head.text);
      const restored = picked.map(invertLineChange);
      return index.encode(applyLineChanges(index.text, lines, restored, breaks[0] ?? "\n"));
    }),
  );
}

function lineChanges(original: string, modified: string): LineChange[] {
  return computeDirtyChanges(original, modified, false).map(lineChangeOfDirty);
}

interface TextAtRef {
  text: string;
  encode(text: string): string;
}

async function readText(
  workspaceId: string,
  ref: "HEAD" | "INDEX",
  relPath: string,
  signal: AbortSignal,
): Promise<TextAtRef | null> {
  const result = unwrapGitResult(
    await ipcCallResult("git", "getFileContent", { workspaceId, ref, relPath }, { signal }),
  );
  if (result.kind !== "ok") return null;
  if (result.isBinary || result.encoding === "bytes" || result.content.includes("�")) {
    throw new Error(i18next.t("editor.stage_lines_text_only"));
  }
  const bom = result.encoding === "utf8-bom" ? "﻿" : "";
  return { text: result.content, encode: (text) => bom + text };
}

const pending = new Map<string, Promise<void>>();

function serialized(workspaceId: string, relPath: string, task: () => Promise<void>) {
  const key = `${workspaceId}\0${relPath}`;
  const run = (pending.get(key) ?? Promise.resolve()).then(task);
  const settled = run.catch(() => {});
  pending.set(key, settled);
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
  return run;
}
