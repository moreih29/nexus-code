import { TERMINAL_FLOW_CONTROL } from "../../../shared/terminal-flow-control";
import { ipcCall, ipcListen } from "../../ipc/client";
import type { PtyClient, PtyClientOptions, TerminalDimensions } from "./types";

const pendingAckCharsByTabId = new Map<string, number>();
const liveSessions = new Set<string>();
const spawnPromisesByTabId = new Map<string, Promise<{ pid: number }>>();

function ackData(tabId: string, chunk: string): void {
  const pending = (pendingAckCharsByTabId.get(tabId) ?? 0) + chunk.length;
  if (pending < TERMINAL_FLOW_CONTROL.ACK_SIZE) {
    pendingAckCharsByTabId.set(tabId, pending);
    return;
  }

  pendingAckCharsByTabId.set(tabId, 0);
  ipcCall("pty", "ack", { tabId, bytesConsumed: pending }).catch(() => {});
}

export function spawnSession(
  tabId: string,
  cwd: string,
  { cols, rows }: TerminalDimensions,
): Promise<{ pid: number } | null> {
  if (liveSessions.has(tabId)) return Promise.resolve(null);

  const existing = spawnPromisesByTabId.get(tabId);
  if (existing) return existing;

  const promise = ipcCall("pty", "spawn", { tabId, cwd, cols, rows })
    .then((result) => {
      if (spawnPromisesByTabId.get(tabId) === promise) {
        liveSessions.add(tabId);
      }
      return result;
    })
    .catch((error: unknown) => {
      liveSessions.delete(tabId);
      throw error;
    })
    .finally(() => {
      spawnPromisesByTabId.delete(tabId);
    });

  spawnPromisesByTabId.set(tabId, promise);
  return promise;
}

export function writeSession(tabId: string, data: string): void {
  ipcCall("pty", "write", { tabId, data }).catch(() => {});
}

export function resizeSession(tabId: string, { cols, rows }: TerminalDimensions): void {
  ipcCall("pty", "resize", { tabId, cols, rows }).catch(() => {});
}

export function killSession(tabId: string): void {
  liveSessions.delete(tabId);
  spawnPromisesByTabId.delete(tabId);
  pendingAckCharsByTabId.delete(tabId);
  ipcCall("pty", "kill", { tabId }).catch(() => {});
}

export function createPtyClient({ tabId, cwd, onData, onExit }: PtyClientOptions): PtyClient {
  const unlistenData = ipcListen("pty", "data", (args) => {
    if (args.tabId !== tabId) return;
    onData(args.chunk);
    ackData(tabId, args.chunk);
  });

  const unlistenExit = ipcListen("pty", "exit", (args) => {
    if (args.tabId !== tabId) return;
    liveSessions.delete(tabId);
    spawnPromisesByTabId.delete(tabId);
    pendingAckCharsByTabId.delete(tabId);
    onExit({ code: args.code });
  });

  return {
    spawn: (dimensions) => spawnSession(tabId, cwd, dimensions),
    write: (data) => writeSession(tabId, data),
    resize: (dimensions) => resizeSession(tabId, dimensions),
    dispose() {
      unlistenData();
      unlistenExit();
    },
  };
}
