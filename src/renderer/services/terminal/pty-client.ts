import { AppErrorSchema, appErrorFailed } from "../../../shared/error/app-error";
import { TERMINAL_FLOW_CONTROL } from "../../../shared/pty/flow-control";
import type { ShellChoice } from "../../../shared/pty/shell";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import { surfaceError } from "../error-surface/surface-error";
import type { PtyClient, PtyClientOptions, SpawnedSession, TerminalDimensions } from "./types";

const pendingAckBytesBySessionKey = new Map<string, number>();
const liveSessions = new Set<string>();
const spawnPromisesBySessionKey = new Map<string, Promise<SpawnedSession>>();
interface InputQueue {
  pending: string;
}
const queuedInputBySessionKey = new Map<string, InputQueue>();
const startupInputBySessionKey = new Map<string, StartupInput>();
const textEncoder = new TextEncoder();

function sessionKey(workspaceId: string, tabId: string): string {
  return `${workspaceId}:${tabId}`;
}

function ackData(workspaceId: string, tabId: string, chunk: string): void {
  const key = sessionKey(workspaceId, tabId);
  const pending =
    (pendingAckBytesBySessionKey.get(key) ?? 0) + textEncoder.encode(chunk).byteLength;
  if (pending < TERMINAL_FLOW_CONTROL.ACK_SIZE) {
    pendingAckBytesBySessionKey.set(key, pending);
    return;
  }

  pendingAckBytesBySessionKey.set(key, 0);
  void ipcCallResult("pty", "ack", { workspaceId, tabId, bytesConsumed: pending });
}

export function spawnSession(
  workspaceId: string,
  tabId: string,
  cwd: string,
  { cols, rows }: TerminalDimensions,
  shell?: ShellChoice,
  profile?: string,
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
    ...(profile !== undefined ? { profile } : {}),
  })
    .then((ipcRes) => {
      const result = unwrapIpcResult(ipcRes);
      if (spawnPromisesBySessionKey.get(key) === promise) {
        liveSessions.add(key);
        noteStartupSpawn(key, workspaceId, tabId, result.shellPath);
      }
      return result;
    })
    .catch((error: unknown) => {
      liveSessions.delete(key);
      dropStartupInput(key);
      throw error;
    })
    .finally(() => {
      spawnPromisesBySessionKey.delete(key);
    });

  spawnPromisesBySessionKey.set(key, promise);
  return promise;
}

export function writeSession(workspaceId: string, tabId: string, data: string): void {
  const key = sessionKey(workspaceId, tabId);
  const queued = queuedInputBySessionKey.get(key);
  if (queued) {
    queued.pending += data;
    return;
  }
  const queue = { pending: "" };
  queuedInputBySessionKey.set(key, queue);
  void sendInput(key, queue, workspaceId, tabId, data);
}

async function sendInput(
  key: string,
  queue: InputQueue,
  workspaceId: string,
  tabId: string,
  data: string,
): Promise<void> {
  let next = data;
  try {
    while (next.length > 0) {
      const result = await ipcCallResult("pty", "write", { workspaceId, tabId, data: next });
      if (queuedInputBySessionKey.get(key) !== queue) return;
      if (!result.ok) {
        if (result.kind === "cancelled") return;
        const error = AppErrorSchema.safeParse(result);
        surfaceError(
          error.success
            ? error.data
            : appErrorFailed(result.message, {
                code: "terminal-input-failed",
              }),
          { surface: "toast" },
        );
        return;
      }
      next = queue.pending;
      queue.pending = "";
    }
  } catch (error) {
    if (queuedInputBySessionKey.get(key) === queue) {
      surfaceError(appErrorFailed(String(error), { code: "terminal-input-failed" }), {
        surface: "toast",
      });
    }
  } finally {
    if (queuedInputBySessionKey.get(key) === queue) queuedInputBySessionKey.delete(key);
  }
}

interface StartupInput {
  readonly build: (shellPath: string | undefined) => string;
  quiet: boolean;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxWaitTimer?: ReturnType<typeof setTimeout>;
  write?: () => void;
}

export const STARTUP_INPUT_QUIET_MS = 300;
export const STARTUP_INPUT_MAX_WAIT_MS = 5000;

export function queueStartupInput(
  workspaceId: string,
  tabId: string,
  build: (shellPath: string | undefined) => string,
): void {
  const key = sessionKey(workspaceId, tabId);
  dropStartupInput(key);
  startupInputBySessionKey.set(key, { build, quiet: false });
}

function noteStartupSpawn(
  key: string,
  workspaceId: string,
  tabId: string,
  shellPath: string | undefined,
): void {
  const pending = startupInputBySessionKey.get(key);
  if (!pending) return;
  pending.write = () => {
    dropStartupInput(key);
    writeSession(workspaceId, tabId, pending.build(shellPath));
  };
  pending.maxWaitTimer = setTimeout(pending.write, STARTUP_INPUT_MAX_WAIT_MS);
  if (pending.quiet) pending.write();
}

function noteStartupOutput(key: string): void {
  const pending = startupInputBySessionKey.get(key);
  if (!pending) return;
  pending.quiet = false;
  clearTimeout(pending.quietTimer);
  pending.quietTimer = setTimeout(() => {
    pending.quiet = true;
    pending.write?.();
  }, STARTUP_INPUT_QUIET_MS);
}

function dropStartupInput(key: string): void {
  const pending = startupInputBySessionKey.get(key);
  if (!pending) return;
  clearTimeout(pending.quietTimer);
  clearTimeout(pending.maxWaitTimer);
  startupInputBySessionKey.delete(key);
}

export function resizeSession(
  workspaceId: string,
  tabId: string,
  { cols, rows }: TerminalDimensions,
): void {
  void ipcCallResult("pty", "resize", { workspaceId, tabId, cols, rows });
}

export function killSession(workspaceId: string, tabId: string): void {
  forgetSession(workspaceId, tabId);
  void ipcCallResult("pty", "kill", { workspaceId, tabId });
}

export function forgetSession(workspaceId: string, tabId: string): void {
  const key = sessionKey(workspaceId, tabId);
  liveSessions.delete(key);
  spawnPromisesBySessionKey.delete(key);
  pendingAckBytesBySessionKey.delete(key);
  queuedInputBySessionKey.delete(key);
  dropStartupInput(key);
}

export function createPtyClient({
  workspaceId,
  tabId,
  cwd,
  shell,
  profile,
  onData,
  onExit,
}: PtyClientOptions): PtyClient {
  const unlistenData = ipcListen("pty", "data", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    onData(args.chunk, args.replay === true);
    ackData(workspaceId, tabId, args.chunk);
    if (args.replay !== true) noteStartupOutput(sessionKey(workspaceId, tabId));
  });

  const unlistenExit = ipcListen("pty", "exit", (args) => {
    if (args.workspaceId !== workspaceId || args.tabId !== tabId) return;
    forgetSession(workspaceId, tabId);
    onExit({ code: args.code });
  });

  return {
    spawn: (dimensions) => spawnSession(workspaceId, tabId, cwd, dimensions, shell, profile),
    write: (data) => writeSession(workspaceId, tabId, data),
    resize: (dimensions) => resizeSession(workspaceId, tabId, dimensions),
    dispose() {
      unlistenData();
      unlistenExit();
    },
  };
}
