import i18next from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isAbortError } from "../../../shared/abort";
import { FS_ERROR, hasFsErrorCode } from "../../../shared/fs/errors";
import type { DiffTabPayload } from "../../../shared/types/tab";
import { ipcCallResult, ipcListen, unwrapGitResult, unwrapIpcResult } from "../../ipc/client";
import type { TextEncoding } from "../../services/editor/encoding/text-encoding";
import { decodeFileContent } from "../../services/editor/model/file-loader";
import { fsErrorReason } from "../../utils/file-error";
import { isRecord } from "../../utils/is-record";
import { EMPTY_TREE } from "./diff-refs";

const RELOAD_DEBOUNCE_MS = 120;

export const REFRESHING_INDICATOR_DELAY_MS = 400;

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
  encoding: TextEncoding;
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

export function useDiffContent(payload: DiffTabPayload): UseDiffContentResult {
  const { workspaceId, relPath, leftRef, rightRef, oldRelPath } = payload;
  const requestPair = useMemo(
    () => buildRequests({ workspaceId, relPath, leftRef, rightRef, oldRelPath }),
    [workspaceId, relPath, leftRef, rightRef, oldRelPath],
  );
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
            message: tooLarge ? i18next.t("editor.diff_too_large") : errorMessage(error),
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
      if (event.workspaceId !== workspaceId) return;
      if (rightRef !== "WORKING") return;
      const watches = new Set([relPath, oldRelPath].filter(Boolean));
      if (!event.changes.some((change) => watches.has(change.relPath))) return;
      scheduleReload("right");
    });

    const unsubscribeGit = ipcListen("git", "statusChanged", (event) => {
      if (event.workspaceId !== workspaceId) return;
      if (leftRef !== "WORKING") scheduleReload("left");
      if (rightRef !== "WORKING") scheduleReload("right");
    });

    return () => {
      unsubscribeFs();
      unsubscribeGit();
    };
  }, [workspaceId, relPath, leftRef, rightRef, oldRelPath, scheduleReload]);

  return {
    left,
    right,
    status: computeStatus(left, right),
    reload,
  };
}

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

export async function readSideContent(
  request: DiffSideRequest,
  signal: AbortSignal,
): Promise<Omit<DiffSideReadyState, "phase" | "request">> {
  if (request.ref === EMPTY_TREE) {
    return {
      content: "",
      encoding: "utf8",
      sizeBytes: 0,
      isBinary: false,
      mtime: new Date().toISOString(),
    };
  }

  const result =
    request.source === "fs"
      ? unwrapIpcResult(
          await ipcCallResult(
            "fs",
            "readFile",
            { workspaceId: request.workspaceId, relPath: request.relPath },
            { signal },
          ),
        )
      : unwrapGitResult(
          await ipcCallResult(
            "git",
            "getFileContent",
            { workspaceId: request.workspaceId, ref: request.ref, relPath: request.relPath },
            { signal },
          ),
        );

  if (result.kind === "missing") {
    return {
      content: "",
      encoding: "utf8",
      sizeBytes: 0,
      isBinary: false,
      mtime: new Date().toISOString(),
      placeholder: "missing" as const,
    };
  }

  const { kind: _kind, ...read } = result;
  const decoded = decodeFileContent(read);
  return {
    content: decoded.content,
    encoding: decoded.encoding,
    sizeBytes: decoded.sizeBytes,
    isBinary: decoded.isBinary,
    mtime: decoded.mtime,
  };
}

function loadingState(
  request: DiffSideRequest,
  previous?: DiffSideReadyState,
): DiffSideLoadingState {
  return { phase: "loading", request, ...(previous ? { previous } : {}) };
}

export function readyContentFor(state: DiffSideState): DiffSideReadyState | undefined {
  if (state.phase === "ready") return state;
  if (state.phase === "loading") return state.previous;
  return undefined;
}

export function computeStatus(left: DiffSideState, right: DiffSideState): DiffContentStatus {
  if (left.phase === "error" || right.phase === "error") return "error";
  if (left.phase === "loading" || right.phase === "loading") {
    return readyContentFor(left) && readyContentFor(right) ? "refreshing" : "loading";
  }
  return "ready";
}

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

function isMissingContentError(error: unknown): boolean {
  if (hasFsErrorCode(error, FS_ERROR.NOT_FOUND)) return true;
  if (isRecord(error) && error.kind === "missing") return true;
  const message = errorMessage(error);
  return /invalid object name|path .+ does not exist in|exists on disk, but not in|did not match any file|pathspec .+ did not match|unknown revision or path not in the working tree/i.test(
    message,
  );
}

function isTooLargeError(error: unknown): boolean {
  if (hasFsErrorCode(error, FS_ERROR.TOO_LARGE)) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /output exceeded .+ limit|too large/i.test(message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error || typeof error === "string") return fsErrorReason(error);
  return i18next.t("editor.diff_load_failed");
}
