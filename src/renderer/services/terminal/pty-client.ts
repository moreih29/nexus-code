import { TERMINAL_FLOW_CONTROL } from "../../../shared/pty/flow-control";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import type { PtyClient, PtyClientOptions, TerminalDimensions } from "./types";

const pendingAckBytesBySessionKey = new Map<string, number>();
const liveSessions = new Set<string>();
const spawnPromisesBySessionKey = new Map<string, Promise<{ pid: number }>>();
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
): Promise<{ pid: number } | null> {
  const key = sessionKey(workspaceId, tabId);
  if (liveSessions.has(key)) return Promise.resolve(null);

  const existing = spawnPromisesBySessionKey.get(key);
  if (existing) return existing;

  const promise = ipcCallResult("pty", "spawn", { workspaceId, tabId, cwd, cols, rows })
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

export function writeSession(workspaceId: string, tabId: string, data: string): void {
  // Fire-and-forget: write is a terminal data push; failure is visible to the user.
  void ipcCallResult("pty", "write", { workspaceId, tabId, data });
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
  const key = sessionKey(workspaceId, tabId);
  liveSessions.delete(key);
  spawnPromisesBySessionKey.delete(key);
  pendingAckBytesBySessionKey.delete(key);
  // Fire-and-forget: kill is a best-effort cleanup; PTY exits independently.
  void ipcCallResult("pty", "kill", { workspaceId, tabId });
}

export function createPtyClient({
  workspaceId,
  tabId,
  cwd,
  onData,
  onExit,
}: PtyClientOptions): PtyClient {
  const unlistenData = ipcListen("pty", "data", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    onData(args.chunk);
    ackData(workspaceId, tabId, args.chunk);
  });

  const unlistenExit = ipcListen("pty", "exit", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    const key = sessionKey(workspaceId, tabId);
    liveSessions.delete(key);
    spawnPromisesBySessionKey.delete(key);
    pendingAckBytesBySessionKey.delete(key);
    onExit({ code: args.code });
  });

  return {
    spawn: (dimensions) => spawnSession(workspaceId, tabId, cwd, dimensions),
    write: (data) => writeSession(workspaceId, tabId, data),
    resize: (dimensions) => resizeSession(workspaceId, tabId, dimensions),
    dispose() {
      unlistenData();
      unlistenExit();
    },
  };
}
