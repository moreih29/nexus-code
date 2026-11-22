/**
 * Another computer's files, kept current while a view shows them. A file is
 * read once for all the views of it; it is read again when that computer's
 * chat says it changed the file (refreshPeerFiles), when the window is
 * looked at again, and, where the host stamps files with a generation
 * (files.read's version), every POLL_MS while the window is visible. A
 * re-read first asks the generation alone (one byte, answered as
 * notModified by the cache in main while the file stands) and reads the
 * file only when it moved. What a view shows stays while it is read again,
 * and changes only when the content did.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type PeerWorkspace, peerOf } from "../../../shared/fs/peer-url";
import type { ToolCall } from "../chat/model";
import { changedFilesOf } from "../chat/panel";
import {
  type PeerText,
  probePeerVersion,
  readPeerTextVersioned,
  readPeerWorkspaceText,
} from "./peer-workspace";

/**
 * How often a shown file's generation is asked. It is one conditional
 * byte read over the room, so a few seconds keeps a panel left open close
 * behind an agent's edits without making the room busy; a host that gives
 * no generation is never polled, as asking it means reading the whole file.
 */
export const PEER_FILE_POLL_MS = 5000;

export interface PeerFileSnapshot {
  /** null for a file watched by its generation only (usePeerFileRevision). */
  readonly text: PeerText | null;
  /** Counts the file's changes seen, for a view that shows it by URL (an image). */
  readonly revision: number;
  readonly version?: string;
}

interface Entry {
  readonly key: string;
  readonly workspaceId: string;
  readonly path: string;
  /** "version": only its generation is followed, for a view that loads the bytes itself. */
  readonly mode: "text" | "workspace-text" | "version";
  readonly peer: PeerWorkspace;
  readonly listeners: Set<() => void>;
  snapshot: PeerFileSnapshot | null;
  /** The generation of what is shown; undefined when the host gives none. */
  version: string | undefined;
  flight: Promise<void> | null;
  /** A read was asked for while one was on its way: another follows it. */
  again: boolean;
  abort: AbortController;
}

const entries = new Map<string, Entry>();
let timer: ReturnType<typeof setInterval> | null = null;
let removeWindowListeners: (() => void) | null = null;

const keyOf = (workspaceId: string, path: string, mode: Entry["mode"], connection = 0) =>
  JSON.stringify([workspaceId, path, mode, connection]);

function sameText(a: PeerText | null, b: PeerText): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "text" && b.kind === "text") {
    return a.text === b.text && a.truncated === b.truncated;
  }
  if (a.kind === "failed" && b.kind === "failed") return a.reason === b.reason;
  return true;
}

function publish(entry: Entry, text: PeerText, version: string | undefined): void {
  entry.version = version;
  const was = entry.snapshot;
  if (was && sameText(was.text, text)) return;
  entry.snapshot = { text, revision: (was?.revision ?? 0) + 1 };
  for (const listener of [...entry.listeners]) listener();
}

async function loadVersion(entry: Entry, again: boolean): Promise<void> {
  const { signal } = entry.abort;
  const now = await probePeerVersion(entry.peer, entry.path, signal).catch(() => null);
  if (signal.aborted || now === null) return;
  const was = entry.version;
  entry.version = now;
  // A host that gives no generation cannot say a file stayed: asked again, it changed.
  const moved = again && (now === undefined || now !== was);
  const revision = (entry.snapshot?.revision ?? 0) + (moved ? 1 : 0);
  if (entry.snapshot && !moved) return;
  entry.snapshot = { text: null, revision, version: now };
  for (const listener of [...entry.listeners]) listener();
}

async function load(entry: Entry, probe: boolean): Promise<void> {
  if (entry.mode === "version") return loadVersion(entry, probe);
  const { signal } = entry.abort;
  if (probe && entry.version !== undefined) {
    const now = await probePeerVersion(entry.peer, entry.path, signal).catch(() => null);
    if (signal.aborted || (now !== null && now === entry.version)) return;
  }
  const readText = entry.mode === "workspace-text" ? readPeerWorkspaceText : readPeerTextVersioned;
  const read = await readText(entry.peer, entry.path, signal).catch(
    (): { text: PeerText; version?: string } => ({ text: { kind: "failed" } }),
  );
  const retain =
    entry.mode === "workspace-text" &&
    entry.snapshot?.text?.kind === "text" &&
    isTransientPeerRead(read.text);
  if (!signal.aborted && !retain) publish(entry, read.text, read.version);
}

/** Reads the file now, or after the read on its way; asks made meanwhile make one more read. */
function refresh(entry: Entry, probe: boolean): void {
  if (entry.flight) {
    entry.again = true;
    return;
  }
  entry.flight = load(entry, probe).finally(() => {
    entry.flight = null;
    if (entry.again && !entry.abort.signal.aborted) {
      entry.again = false;
      refresh(entry, true);
    }
  });
}

function windowVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function poll(): void {
  if (!windowVisible()) return;
  for (const entry of entries.values()) if (entry.version !== undefined) refresh(entry, true);
}

function onWindowBack(): void {
  if (!windowVisible()) return;
  for (const entry of entries.values()) refresh(entry, true);
}

function start(): void {
  if (timer) return;
  timer = setInterval(poll, PEER_FILE_POLL_MS);
  if (
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof document !== "undefined" &&
    typeof document.addEventListener === "function"
  ) {
    window.addEventListener("focus", onWindowBack);
    document.addEventListener("visibilitychange", onWindowBack);
    removeWindowListeners = () => {
      window.removeEventListener("focus", onWindowBack);
      document.removeEventListener("visibilitychange", onWindowBack);
    };
  }
}

function stop(): void {
  if (timer) clearInterval(timer);
  timer = null;
  removeWindowListeners?.();
  removeWindowListeners = null;
}

/** Shows a view of a file of another computer's; returns the stop function. */
export function watchPeerFile(
  workspaceId: string,
  path: string,
  listener: () => void,
  mode: Entry["mode"] = "text",
  connection = 0,
): () => void {
  const peer = peerOf(workspaceId);
  if (!peer) return () => {};
  const key = keyOf(workspaceId, path, mode, connection);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      key,
      workspaceId,
      path,
      mode,
      peer,
      listeners: new Set(),
      snapshot: null,
      version: undefined,
      flight: null,
      again: false,
      abort: new AbortController(),
    };
    entries.set(key, entry);
    start();
    refresh(entry, false);
  }
  const mine = entry;
  mine.listeners.add(listener);
  return () => {
    mine.listeners.delete(listener);
    if (mine.listeners.size > 0) return;
    mine.abort.abort();
    if (entries.get(key) === mine) entries.delete(key);
    if (entries.size === 0) stop();
  };
}

const slashed = (path: string) => path.replace(/\\/g, "/");

function sameFile(watched: string, changed: string): boolean {
  const a = slashed(watched);
  const b = slashed(changed);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/**
 * That computer's chat changed these files: those shown are read again. No
 * paths: every file shown of that workspace.
 */
export function refreshPeerFiles(workspaceId: string, paths?: readonly string[]): void {
  for (const entry of entries.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    if (paths && !paths.some((path) => sameFile(entry.path, path))) continue;
    refresh(entry, true);
  }
}

/** What is shown of a file now, for tests and views that read it once. */
export function peerFileSnapshot(
  workspaceId: string,
  path: string,
  mode: Entry["mode"] = "text",
  connection = 0,
): PeerFileSnapshot | null {
  return entries.get(keyOf(workspaceId, path, mode, connection))?.snapshot ?? null;
}

/** How many files are kept current now. */
export function watchedPeerFileCount(): number {
  return entries.size;
}

/** Whether the periodic check runs: only while some file is shown. */
export function peerFilePollRunning(): boolean {
  return timer !== null;
}

function useSnapshot(
  workspaceId: string,
  path: string,
  mode: Entry["mode"],
  enabled = true,
  connection = 0,
): PeerFileSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? watchPeerFile(workspaceId, path, listener, mode, connection) : () => {},
    [workspaceId, path, mode, enabled, connection],
  );
  const get = useCallback(
    () => (enabled ? peerFileSnapshot(workspaceId, path, mode, connection) : null),
    [workspaceId, path, mode, enabled, connection],
  );
  return useSyncExternalStore(subscribe, get, get);
}

/**
 * The text another computer's file holds, read through the room and kept
 * current; null while it comes. Views of one file share their reads.
 */
export function usePeerText(workspaceId: string, path: string): PeerText | null {
  return useSnapshot(workspaceId, path, "text")?.text ?? null;
}

function isTransientPeerRead(text: PeerText): boolean {
  return text.kind === "failed" && (!text.reason || text.reason === "unavailable");
}

/** A workspace tab retains its last read while inactive or disconnected. */
export function usePeerWorkspaceText(
  workspaceId: string,
  path: string,
  enabled: boolean,
  connection: number,
): PeerText | null {
  const text = useSnapshot(workspaceId, path, "workspace-text", enabled, connection)?.text ?? null;
  const [last, setLast] = useState<PeerText | null>(null);
  if (!text) return last;
  // A dropped request can arrive a render before the room reports the loss.
  if (last?.kind === "text" && isTransientPeerRead(text)) return last;
  if (text !== last) setLast(text);
  return text;
}

/** Keeps a URL revision stable while the tab is hidden or the peer is away. */
export function usePeerWorkspaceRevision(
  workspaceId: string,
  path: string,
  enabled: boolean,
  connection: number,
): number {
  const snapshot = useSnapshot(workspaceId, path, "version", enabled, connection);
  const [last, setLast] = useState(() => ({ connection, snapshot, revision: 0 }));
  if (snapshot && (snapshot !== last.snapshot || connection !== last.connection)) {
    const moved =
      last.snapshot !== null &&
      (connection !== last.connection ||
        snapshot.version !== last.snapshot.version ||
        (snapshot.version === undefined && snapshot.revision !== last.snapshot.revision));
    setLast({ connection, snapshot, revision: last.revision + Number(moved) });
  }
  return last.revision;
}

/**
 * How many times the file changed since it was first looked at (0 before),
 * to key a view that loads the bytes itself, as an image does by its URL.
 * Only the generation is followed, never the content.
 */
export function usePeerFileRevision(
  workspaceId: string,
  path: string,
  enabled = true,
  connection = 0,
): number {
  return useSnapshot(workspaceId, path, "version", enabled, connection)?.revision ?? 0;
}

/** What a chat's changed files and finished edit calls say of each file, by path. */
function changeMarks(
  changed: readonly { path: string; added?: number; removed?: number; created?: boolean }[],
  tools: Record<string, ToolCall>,
): Map<string, string> {
  const marks = new Map<string, string>();
  for (const file of changed) {
    marks.set(slashed(file.path), `${file.added ?? 0}:${file.removed ?? 0}:${file.created ?? ""}`);
  }
  // A call that finished is a change even where the counts stay what they were.
  for (const file of changedFilesOf(tools)) {
    const path = slashed(file.path);
    marks.set(path, `${marks.get(path) ?? ""}|${file.toolUseIds.length}`);
  }
  return marks;
}

/**
 * Tells the views of that computer's files which its chat changed: from
 * each new state of the chat's changed files and tool calls, the files
 * whose marks moved since the last are read again. The first state only
 * sets the marks: what was changed before the view opened is read anyway.
 */
export function usePeerChatFileChanges(
  workspaceId: string,
  changed: readonly { path: string; added?: number; removed?: number; created?: boolean }[],
  tools: Record<string, ToolCall>,
): void {
  const last = useRef<{ workspaceId: string; marks: Map<string, string> } | null>(null);
  useEffect(() => {
    const marks = changeMarks(changed, tools);
    const was = last.current?.workspaceId === workspaceId ? last.current.marks : null;
    last.current = { workspaceId, marks };
    if (!was) return;
    const moved = [...marks].filter(([path, mark]) => was.get(path) !== mark).map(([path]) => path);
    if (moved.length > 0) refreshPeerFiles(workspaceId, moved);
  }, [workspaceId, changed, tools]);
}
