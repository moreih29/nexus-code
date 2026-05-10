import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs-errors";
import type { FileContent } from "../../../shared/types/fs";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { ipcCall, ipcListen } from "../../ipc/client";
import { EMPTY_TREE } from "./diff-refs";

const RELOAD_DEBOUNCE_MS = 120;

type DiffSideName = "left" | "right";
type DiffContentSource = "git" | "fs";

export interface DiffSideRequest {
  side: DiffSideName;
  workspaceId: string;
  relPath: string;
  ref: string;
  source: DiffContentSource;
}

export interface DiffSideReadyState {
  phase: "ready";
  request: DiffSideRequest;
  content: string;
  encoding: FileContent["encoding"];
  sizeBytes: number;
  isBinary: boolean;
  mtime: string;
  placeholder?: "missing";
}

export interface DiffSideLoadingState {
  phase: "loading";
  request: DiffSideRequest;
  previous?: DiffSideReadyState;
}

export interface DiffSideErrorState {
  phase: "error";
  request: DiffSideRequest;
  message: string;
  tooLarge: boolean;
}

export type DiffSideState = DiffSideReadyState | DiffSideLoadingState | DiffSideErrorState;
export type DiffContentStatus = "loading" | "refreshing" | "ready" | "error";

export interface UseDiffContentResult {
  left: DiffSideState;
  right: DiffSideState;
  status: DiffContentStatus;
  reload: () => void;
}

interface SideRefs<T> {
  left: T;
  right: T;
}

/**
 * Fetches both sides of a source-control diff and refreshes them from IPC hints.
 */
export function useDiffContent(payload: DiffTabPayload): UseDiffContentResult {
  const requestPair = useMemo(() => buildRequests(payload), [payload]);
  const [left, setLeft] = useState<DiffSideState>(() => loadingState(requestPair.left));
  const [right, setRight] = useState<DiffSideState>(() => loadingState(requestPair.right));

  const versionsRef = useRef<SideRefs<number>>({ left: 0, right: 0 });
  const controllersRef = useRef<SideRefs<AbortController | null>>({ left: null, right: null });
  const timersRef = useRef<SideRefs<ReturnType<typeof setTimeout> | null>>({
    left: null,
    right: null,
  });

  const loadSide = useCallback(
    (side: DiffSideName) => {
      const request = requestPair[side];
      const version = versionsRef.current[side] + 1;
      versionsRef.current[side] = version;

      controllersRef.current[side]?.abort();
      const controller = new AbortController();
      controllersRef.current[side] = controller;

      const setSide = side === "left" ? setLeft : setRight;
      setSide((current) => loadingState(request, readyContentFor(current)));

      void readSideContent(request, controller.signal).then(
        (content) => {
          if (versionsRef.current[side] !== version) return;
          controllersRef.current[side] = null;
          setSide({ phase: "ready", request, ...content });
        },
        (error) => {
          if (versionsRef.current[side] !== version) return;
          controllersRef.current[side] = null;
          if (isAbortError(error)) return;

          if (isMissingContentError(error)) {
            setSide({
              phase: "ready",
              request,
              content: "",
              encoding: "utf8",
              sizeBytes: 0,
              isBinary: false,
              mtime: new Date().toISOString(),
              placeholder: "missing",
            });
            return;
          }

          const tooLarge = isTooLargeError(error);
          setSide({
            phase: "error",
            request,
            message: tooLarge ? "File too large to diff." : errorMessage(error),
            tooLarge,
          });
        },
      );
    },
    [requestPair],
  );

  const reload = useCallback(() => {
    loadSide("left");
    loadSide("right");
  }, [loadSide]);

  const scheduleReload = useCallback(
    (side: DiffSideName) => {
      if (timersRef.current[side] !== null) {
        clearTimeout(timersRef.current[side]);
      }
      timersRef.current[side] = setTimeout(() => {
        timersRef.current[side] = null;
        loadSide(side);
      }, RELOAD_DEBOUNCE_MS);
    },
    [loadSide],
  );

  useEffect(() => {
    reload();
    return () => {
      disposeSideEffects(versionsRef.current, controllersRef.current, timersRef.current);
    };
  }, [reload]);

  useEffect(() => {
    const unsubscribeFs = ipcListen("fs", "changed", (event) => {
      if (event.workspaceId !== payload.workspaceId) return;
      if (payload.rightRef !== "WORKING") return;
      const watches = new Set([payload.relPath, payload.oldRelPath].filter(Boolean));
      if (!event.changes.some((change) => watches.has(change.relPath))) return;
      scheduleReload("right");
    });

    const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
      if (event.workspaceId !== payload.workspaceId) return;
      if (payload.leftRef !== "WORKING") scheduleReload("left");
      if (payload.rightRef !== "WORKING") scheduleReload("right");
    });

    return () => {
      unsubscribeFs();
      unsubscribeGit();
    };
  }, [payload, scheduleReload]);

  return {
    left,
    right,
    status: computeStatus(left, right),
    reload,
  };
}

/**
 * Chooses the fetch source and path for each side of the diff.
 */
function buildRequests(payload: DiffTabPayload): SideRefs<DiffSideRequest> {
  return {
    left: {
      side: "left",
      workspaceId: payload.workspaceId,
      relPath: payload.oldRelPath ?? payload.relPath,
      ref: payload.leftRef,
      source: "git",
    },
    right: {
      side: "right",
      workspaceId: payload.workspaceId,
      relPath: payload.relPath,
      ref: payload.rightRef,
      source: payload.rightRef === "WORKING" ? "fs" : "git",
    },
  };
}

/**
 * Reads one side through the correct IPC channel.
 * When ref is EMPTY_TREE (unborn repository left side), no IPC call is issued
 * and empty content is returned immediately — BranchInfo.isUnborn=true origin.
 *
 * Exported for unit testing of the EMPTY_TREE short-circuit path.
 */
export async function readSideContent(
  request: DiffSideRequest,
  signal: AbortSignal,
): Promise<Omit<DiffSideReadyState, "phase" | "request">> {
  if (request.ref === EMPTY_TREE) {
    return { content: "", encoding: "utf8", sizeBytes: 0, isBinary: false, mtime: new Date().toISOString() };
  }

  const result =
    request.source === "fs"
      ? await ipcCall(
          "fs",
          "readFile",
          { workspaceId: request.workspaceId, relPath: request.relPath },
          { signal },
        )
      : await ipcCall(
          "git",
          "getFileContent",
          { workspaceId: request.workspaceId, ref: request.ref, relPath: request.relPath },
          { signal },
        );

  if (result.kind === "missing") {
    return { content: "", encoding: "utf8", sizeBytes: 0, isBinary: false, mtime: new Date().toISOString(), placeholder: "missing" as const };
  }

  return {
    content: result.content,
    encoding: result.encoding,
    sizeBytes: result.sizeBytes,
    isBinary: result.isBinary,
    mtime: result.mtime,
  };
}

/**
 * Builds a loading state while preserving the last displayable side content.
 */
function loadingState(
  request: DiffSideRequest,
  previous?: DiffSideReadyState,
): DiffSideLoadingState {
  return { phase: "loading", request, ...(previous ? { previous } : {}) };
}

/**
 * Returns content that can stay visible while a newer request is in flight.
 */
export function readyContentFor(state: DiffSideState): DiffSideReadyState | undefined {
  if (state.phase === "ready") return state;
  if (state.phase === "loading") return state.previous;
  return undefined;
}

/**
 * Computes the aggregate loading state for the diff view shell.
 */
function computeStatus(left: DiffSideState, right: DiffSideState): DiffContentStatus {
  if (left.phase === "error" || right.phase === "error") return "error";
  if (left.phase === "loading" || right.phase === "loading") {
    return readyContentFor(left) && readyContentFor(right) ? "refreshing" : "loading";
  }
  return "ready";
}

/**
 * Cancels in-flight fetches and invalidates version tokens on unmount.
 */
function disposeSideEffects(
  versions: SideRefs<number>,
  controllers: SideRefs<AbortController | null>,
  timers: SideRefs<ReturnType<typeof setTimeout> | null>,
): void {
  versions.left += 1;
  versions.right += 1;
  controllers.left?.abort();
  controllers.right?.abort();
  controllers.left = null;
  controllers.right = null;
  for (const side of ["left", "right"] as const) {
    if (timers[side] !== null) clearTimeout(timers[side]);
    timers[side] = null;
  }
}

/**
 * Detects abort errors from DOM AbortController and Electron-wrapped calls.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Maps not-found reads to an empty side so added/deleted files can still diff.
 * Prefers the typed GitError kind ("missing") when the main process classified
 * the failure; falls back to a regex on the message for non-Git error shapes.
 */
function isMissingContentError(error: unknown): boolean {
  if (hasFsErrorCode(error, FS_ERROR.NOT_FOUND)) return true;
  if (isRecord(error) && error.kind === "missing") return true;
  const message = errorMessage(error);
  return /invalid object name|path .+ does not exist in|exists on disk, but not in|did not match any file|pathspec .+ did not match|unknown revision or path not in the working tree/i.test(
    message,
  );
}

/**
 * Narrow unknown values to object records for safe property access.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Detects read-size failures from fs.readFile and git.getFileContent.
 */
function isTooLargeError(error: unknown): boolean {
  if (hasFsErrorCode(error, FS_ERROR.TOO_LARGE)) return true;
  return /output exceeded .+ limit|too large/i.test(errorMessage(error));
}

/**
 * Extracts a renderer-visible error message from unknown rejection payloads.
 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Failed to load diff content.";
}
