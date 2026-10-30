import { TERMINAL_FLOW_CONTROL } from "../../../shared/pty/flow-control";
import type { ShellChoice } from "../../../shared/pty/shell";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import type { PtyClient, PtyClientOptions, SpawnedSession, TerminalDimensions } from "./types";

const pendingAckBytesBySessionKey = new Map<string, number>();
const liveSessions = new Set<string>();
const spawnPromisesBySessionKey = new Map<string, Promise<SpawnedSession>>();
/** Input waiting for the session's write in flight; present while one is. */
const queuedInputBySessionKey = new Map<string, string>();
const textEncoder = new TextEncoder();

function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

function ackData(workspaceId: string, tabId: string, chunk: string): void {
  const key = sessionKey(workspaceId, tabId);
  const pending = (pendingAckBytesBySessionKey.get(key) ?? 0) + textEncoder.encode(chunk).byteLength;
  if (pending < TERMINAL_FLOW_CONTROL.ACK_SIZE) {
    pendingAckBytesBySessionKey.set(key, pending);
    return;
  }

  pendingAckBytesBySessionKey.set(key, 0);
  // Fire-and-forget: ack is a flow-control notification; terminal still works without it.
  void ipcCallResult("pty", "ack", { workspaceId, tabId, bytesConsumed: pending });
}

export function spawnSession(
  workspaceId: string,
  tabId: string,
  cwd: string,
  { cols, rows }: TerminalDimensions,
  shell?: ShellChoice,
): Promise<SpawnedSession | null> {
  const key = sessionKey(workspaceId, tabId);
  if (liveSessions.has(key)) return Promise.resolve(null);

  const existing = spawnPromisesBySessionKey.get(key);
  if (existing) return existing;

  const promise = ipcCallResult("pty", "spawn", {
    workspaceId,
    tabId,
    cwd,
    cols,
    rows,
    ...(shell !== undefined ? { shell } : {}),
  })
    .then((ipcRes) => {
      const result = unwrapIpcResult(ipcRes);
      if (spawnPromisesBySessionKey.get(key) === promise) {
        liveSessions.add(key);
      }
      return result;
    })
    .catch((error: unknown) => {
      liveSessions.delete(key);
      throw error;
    })
    .finally(() => {
      spawnPromisesBySessionKey.delete(key);
    });

  spawnPromisesBySessionKey.set(key, promise);
  return promise;
}

/**
 * Sends a session's input one write at a time. The agent handles each request
 * on a goroutine of its own, so two writes sent back to back can reach the PTY
 * in either order. An IME that commits a syllable on Enter sends the syllable
 * and the Enter within a millisecond, and the command sometimes ran without
 * the syllable. Input that arrives while a write is in flight goes out in the
 * next one.
 */
export function writeSession(workspaceId: string, tabId: string, data: string): void {
  const key = sessionKey(workspaceId, tabId);
  const queued = queuedInputBySessionKey.get(key);
  if (queued !== undefined) {
    queuedInputBySessionKey.set(key, queued + data);
    return;
  }
  queuedInputBySessionKey.set(key, "");
  void sendInput(key, workspaceId, tabId, data);
}

async function sendInput(key: string, workspaceId: string, tabId: string, data: string) {
  let next = data;
  while (next.length > 0) {
    try {
      await ipcCallResult("pty", "write", { workspaceId, tabId, data: next });
    } catch {
      // A failed write is visible to the user; the input after it still goes out.
    }
    next = queuedInputBySessionKey.get(key) ?? "";
    queuedInputBySessionKey.set(key, "");
  }
  queuedInputBySessionKey.delete(key);
}

export function resizeSession(
  workspaceId: string,
  tabId: string,
  { cols, rows }: TerminalDimensions,
): void {
  // Fire-and-forget: resize notification; terminal adapts at next draw.
  void ipcCallResult("pty", "resize", { workspaceId, tabId, cols, rows });
}

export function killSession(workspaceId: string, tabId: string): void {
  forgetSession(workspaceId, tabId);
  // Fire-and-forget: kill is a best-effort cleanup; PTY exits independently.
  void ipcCallResult("pty", "kill", { workspaceId, tabId });
}

/**
 * Drops the bookkeeping for a session that has ended, so the next spawn for
 * the tab reaches main instead of being taken for a session still live.
 */
export function forgetSession(workspaceId: string, tabId: string): void {
  const key = sessionKey(workspaceId, tabId);
  liveSessions.delete(key);
  spawnPromisesBySessionKey.delete(key);
  pendingAckBytesBySessionKey.delete(key);
}

export function createPtyClient({
  workspaceId,
  tabId,
  cwd,
  shell,
  onData,
  onExit,
}: PtyClientOptions): PtyClient {
  const unlistenData = ipcListen("pty", "data", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    onData(args.chunk, args.replay === true);
    ackData(workspaceId, tabId, args.chunk);
  });

  const unlistenExit = ipcListen("pty", "exit", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    forgetSession(workspaceId, tabId);
    onExit({ code: args.code });
  });

  return {
    spawn: (dimensions) => spawnSession(workspaceId, tabId, cwd, dimensions, shell),
    write: (data) => writeSession(workspaceId, tabId, data),
    resize: (dimensions) => resizeSession(workspaceId, tabId, dimensions),
    dispose() {
      unlistenData();
      unlistenExit();
    },
  };
}
