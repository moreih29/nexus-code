/**
 * Stages or unstages chosen lines of one file — VSCode's "Stage Change",
 * "Stage Selected Ranges" and their unstage counterparts.
 *
 * Each request reads the index (and HEAD, to unstage) afresh rather than
 * trusting the copy on screen: a diff shown a moment ago may predate the last
 * staging, and writing an index version built from it would undo that. The
 * new version goes in through the git store's `stageContent`, so progress and
 * failures show like any other stage.
 */

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
  /** Repository-relative path. */
  relPath: string;
  /** The working text the ranges point into: the editor buffer, saved or not. */
  working: string;
  /** The working text's line break, for lines added to a one-line index. */
  eol: string;
  ranges: readonly LineRange[];
}

/** Stages the working changes `ranges` reach. */
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
  /** Repository-relative path of the index entry. */
  relPath: string;
  /** Its path at HEAD, which a staged rename changed. */
  headRelPath: string;
  /** The index text the ranges point into, as the diff shows it. */
  index: string;
  ranges: readonly LineRange[];
}

/** Puts the staged changes `ranges` reach back to HEAD's lines. */
export function unstageLines(request: UnstageLinesRequest): Promise<void> {
  const { workspaceId, relPath, headRelPath, ranges } = request;
  return serialized(workspaceId, relPath, () =>
    useGitStore.getState().stageContent(workspaceId, relPath, "unstage", async (signal) => {
      const [head, index] = await Promise.all([
        readText(workspaceId, "HEAD", headRelPath, signal),
        readText(workspaceId, "INDEX", relPath, signal),
      ]);
      // The ranges are lines of the index on screen; once it has moved on they
      // name other lines, and the diff is about to reload anyway.
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
  // Whitespace counts: staging writes exact text.
  return computeDirtyChanges(original, modified, false).map(lineChangeOfDirty);
}

interface TextAtRef {
  text: string;
  /** The text as the content to stage, with the byte-order mark it was read with. */
  encode(text: string): string;
}

/** The text of `relPath` at `ref`, or null when it has none there. */
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
  // Text that is not UTF-8 comes back with replacement characters; writing it
  // back would put those over the file's own bytes.
  if (result.isBinary || result.content.includes("�")) {
    throw new Error(i18next.t("editor.stage_lines_text_only"));
  }
  const bom = result.encoding === "utf8-bom" ? "﻿" : "";
  return { text: result.content, encode: (text) => bom + text };
}

const pending = new Map<string, Promise<void>>();

/**
 * Runs `task` after the file's earlier requests, so each reads the index the
 * one before it wrote.
 */
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
