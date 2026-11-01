import { TERMINAL_FLOW_CONTROL } from "../../../shared/pty/flow-control";
import type { ShellChoice } from "../../../shared/pty/shell";
import { ipcCallResult, ipcListen, unwrapIpcResult } from "../../ipc/client";
import type { PtyClient, PtyClientOptions, SpawnedSession, TerminalDimensions } from "./types";

const pendingAckBytesBySessionKey = new Map<string, number>();
const liveSessions = new Set<string>();
const spawnPromisesBySessionKey = new Map<string, Promise<SpawnedSession>>();
/** Input waiting for the session's write in flight; present while one is. */
const queuedInputBySessionKey = new Map<string, string>();
/** Input to type once the session's shell is ready; see `queueStartupInput`. */
const startupInputBySessionKey = new Map<string, StartupInput>();
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

interface StartupInput {
  /** Builds the input for the shell that started; a remote shell has no path. */
  readonly build: (shellPath: string | undefined) => string;
  /** The shell printed something and has been quiet since. */
  quiet: boolean;
  quietTimer?: ReturnType<typeof setTimeout>;
  maxWaitTimer?: ReturnType<typeof setTimeout>;
  /** Types the input; set once the session has started. */
  write?: () => void;
}

/** How long a new shell stays quiet after printing before it counts as ready. */
export const STARTUP_INPUT_QUIET_MS = 300;
/** The longest startup input waits for a shell that keeps printing, or never does. */
export const STARTUP_INPUT_MAX_WAIT_MS = 5000;

/**
 * Types input into a tab's shell once the shell is ready, such as a command a
 * new terminal runs. The tab's session must not have started yet. Ready is a
 * guess: the shell printed something, its prompt, and then went quiet. Input
 * typed earlier would still run, since the shell reads it when it gets there,
 * but the terminal would show it twice, before the prompt and after it.
 */
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
  dropStartupInput(key);
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
    if (args.replay !== true) noteStartupOutput(sessionKey(workspaceId, tabId));
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
