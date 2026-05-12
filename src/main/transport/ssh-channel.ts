import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
  spawn,
} from "node:child_process";
import { z } from "zod";
import { PendingRequestMap } from "../../shared/pending-request-map";
import type { SshErrorCode } from "../../shared/types/ssh-errors";
import { classifyStderrLine } from "./ssh-stderr-patterns";

const DISPOSE_KILL_GRACE_MS = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const ReadyFrameSchema = z.object({ type: z.literal("ready") }).passthrough();
const ResponseResultFrameSchema = z.object({ id: z.string(), result: z.unknown() }).passthrough();
const ResponseErrorFrameSchema = z.object({ id: z.string(), error: z.unknown() }).passthrough();
const EventFrameSchema = z
  .object({ event: z.string(), payload: z.unknown().optional() })
  .passthrough();

type SshChildProcess = ChildProcessWithoutNullStreams;
type SpawnSshProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => SshChildProcess;
type SshEventCallback = (payload: unknown) => void;
type SshLifecycleCallback = (event: SshChannelLifecycleEvent) => void;

interface SshError extends Error {
  readonly code: SshErrorCode;
}

type ParsedFrame =
  | { kind: "ready" }
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error-response"; id: string; error: unknown }
  | { kind: "event"; event: string; payload: unknown };

export interface CreateSshChannelOptions {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly remoteCommand: string;
}

export interface SshChannel {
  /**
   * Resolves when the remote agent emits its startup ready frame. If a caller
   * sends a request before awaiting this promise, the first valid response or
   * event also marks the channel ready for compatibility with older agents.
   */
  readonly ready: Promise<void>;
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  on(event: string, callback: SshEventCallback): () => void;
  onLifecycle(callback: SshLifecycleCallback): () => void;
  dispose(): void;
}

export type SshChannelLifecycleEvent =
  | { readonly type: "exit"; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: "failure"; readonly error: Error }
  | { readonly type: "disposed" };

export interface SshChannelDependencies {
  readonly spawn?: SpawnSshProcess;
  readonly requestTimeoutMs?: number;
}

/**
 * Opens an SSH-backed NDJSON request channel to the remote agent.
 */
export function createSshChannel(
  options: CreateSshChannelOptions,
  dependencies: SshChannelDependencies = {},
): SshChannel {
  const spawnSsh = dependencies.spawn ?? defaultSpawnSsh;
  const child = spawnSsh("ssh", buildSshArgs(options), {
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pendingRequests = new PendingRequestMap<string, unknown>();
  const activeRequestIds = new Set<string>();
  const listeners = new Map<string, Set<SshEventCallback>>();
  const lifecycleListeners = new Set<SshLifecycleCallback>();
  const stdoutLines = createLineSplitter(handleStdoutLine);
  const stderrLines = createLineSplitter(handleStderrLine);

  let nextRequestId = 1;
  let disposed = false;
  let closed = false;
  let terminalError: Error | null = null;
  let forceKillTimer: NodeJS.Timeout | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolve();
    };
    rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      reject(error);
    };
  });
  ready.catch(() => {});

  /** Rejects all in-flight requests with the same terminal transport error. */
  function rejectPendingRequests(error: Error): void {
    for (const requestId of Array.from(activeRequestIds)) {
      pendingRequests.reject(requestId, error);
    }
    activeRequestIds.clear();
  }

  /** Records a terminal channel failure and optionally asks the child to exit. */
  function failChannel(error: Error, terminate: boolean): void {
    if (terminalError) return;
    terminalError = error;
    rejectReady(error);
    rejectPendingRequests(error);
    emitLifecycle({ type: "failure", error });
    if (terminate) {
      terminateChild();
    }
  }

  /** Parses one stdout NDJSON line and routes it to ready, call, or event state. */
  function handleStdoutLine(line: string): void {
    if (disposed || terminalError || line.length === 0) return;

    let frame: ParsedFrame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      failChannel(createSshError("server.protocol-error", error), true);
      return;
    }

    if (frame.kind === "ready") {
      resolveReady();
      return;
    }

    resolveReady();
    if (frame.kind === "response") {
      if (!activeRequestIds.has(frame.id)) {
        failChannel(createSshError("server.protocol-error"), true);
        return;
      }
      pendingRequests.resolve(frame.id, frame.result);
      return;
    }

    if (frame.kind === "error-response") {
      if (!activeRequestIds.has(frame.id)) {
        failChannel(createSshError("server.protocol-error"), true);
        return;
      }
      pendingRequests.reject(frame.id, errorFromServerFrame(frame.error));
      return;
    }

    emitEvent(frame.event, frame.payload);
  }

  /** Classifies one stderr line without exposing the raw text to callers. */
  function handleStderrLine(line: string): void {
    if (disposed || terminalError || line.length === 0) return;

    const code = classifyStderrLine(line);
    if (code) {
      failChannel(createSshError(code), true);
    }
  }

  /** Sends SIGTERM now and schedules the 100ms SIGKILL fallback. */
  function terminateChild(): void {
    if (closed || child.killed) return;
    child.kill("SIGTERM");
    scheduleForceKill();
  }

  /** Starts the hard-kill timer used when ssh ignores disposal. */
  function scheduleForceKill(): void {
    if (forceKillTimer) return;
    forceKillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, DISPOSE_KILL_GRACE_MS);
    forceKillTimer.unref?.();
  }

  /** Clears the hard-kill timer after the child exits. */
  function clearForceKillTimer(): void {
    if (!forceKillTimer) return;
    clearTimeout(forceKillTimer);
    forceKillTimer = null;
  }

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutLines.push(chunk);
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk);
  });

  child.on("error", (error) => {
    failChannel(createSshError("server.spawn-failed", error), false);
  });

  child.on("close", (code, signal) => {
    closed = true;
    clearForceKillTimer();
    stdoutLines.flush();
    stderrLines.flush();

    if (disposed || terminalError) return;
    if (code === 0) {
      if (!readySettled) {
        failChannel(createSshError("ssh.unknown"), false);
        return;
      }
      emitLifecycle({ type: "exit", code, signal });
      return;
    }
    failChannel(createSshError("ssh.unknown"), false);
  });

  return {
    ready,
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      if (disposed) {
        return Promise.reject(createDisposedError());
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }

      const requestId = `ssh-${nextRequestId++}`;
      let line: string;
      try {
        line = `${JSON.stringify({ id: requestId, method, params })}\n`;
      } catch (error) {
        return Promise.reject(createSshError("server.protocol-error", error));
      }

      activeRequestIds.add(requestId);
      const promise = pendingRequests
        .register({
          key: requestId,
          timeoutMs: requestTimeoutMs,
          onTimeout: () => createSshError("ssh.unknown"),
        })
        .finally(() => {
          activeRequestIds.delete(requestId);
        }) as Promise<TResult>;

      if (!child.stdin.writable || child.stdin.destroyed) {
        pendingRequests.reject(requestId, createSshError("ssh.unknown"));
        return promise;
      }

      child.stdin.write(line, (error) => {
        if (error) {
          pendingRequests.reject(requestId, createSshError("ssh.unknown", error));
        }
      });

      return promise;
    },
    on(event: string, callback: SshEventCallback): () => void {
      let callbacks = listeners.get(event);
      if (!callbacks) {
        callbacks = new Set<SshEventCallback>();
        listeners.set(event, callbacks);
      }
      callbacks.add(callback);
      return () => {
        const current = listeners.get(event);
        if (!current) return;
        current.delete(callback);
        if (current.size === 0) {
          listeners.delete(event);
        }
      };
    },
    onLifecycle(callback: SshLifecycleCallback): () => void {
      lifecycleListeners.add(callback);
      return () => {
        lifecycleListeners.delete(callback);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const error = createDisposedError();
      rejectReady(error);
      rejectPendingRequests(error);
      listeners.clear();
      if (!terminalError) {
        emitLifecycle({ type: "disposed" });
      }
      if (!child.stdin.destroyed) {
        child.stdin.end();
      }
      terminateChild();
    },
  };

  /** Delivers one transport lifecycle event to currently subscribed callbacks. */
  function emitLifecycle(event: SshChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) {
      callback(event);
    }
  }

  /** Delivers one remote event to currently subscribed callbacks. */
  function emitEvent(event: string, payload: unknown): void {
    const callbacks = listeners.get(event);
    if (!callbacks) return;
    for (const callback of Array.from(callbacks)) {
      callback(payload);
    }
  }
}

/**
 * Creates the OpenSSH argument list without invoking a shell locally.
 */
function buildSshArgs(options: CreateSshChannelOptions): string[] {
  const args = ["-o", "BatchMode=yes"];
  if (options.port !== undefined) {
    args.push("-p", String(options.port));
  }
  if (options.identityFile) {
    args.push("-i", options.identityFile);
  }
  args.push("--", destinationForOptions(options), options.remoteCommand);
  return args;
}

/**
 * Renders the OpenSSH destination from an optional user and host.
 */
function destinationForOptions(options: CreateSshChannelOptions): string {
  return options.user ? `${options.user}@${options.host}` : options.host;
}

/**
 * Production spawn adapter. Tests can inject a fake child through dependencies.
 */
function defaultSpawnSsh(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
): SshChildProcess {
  return spawn(command, args, options) as SshChildProcess;
}

/**
 * Parses exactly one NDJSON frame from stdout.
 */
function parseFrame(line: string): ParsedFrame {
  const parsed: unknown = JSON.parse(line);

  const ready = ReadyFrameSchema.safeParse(parsed);
  if (ready.success) {
    return { kind: "ready" };
  }

  if (!isRecord(parsed)) {
    throw createSshError("server.protocol-error");
  }

  const hasResult = hasOwnKey(parsed, "result");
  const hasError = hasOwnKey(parsed, "error");
  if (hasResult && hasError) {
    throw createSshError("server.protocol-error");
  }

  const response = hasResult ? ResponseResultFrameSchema.safeParse(parsed) : null;
  if (response?.success) {
    return {
      kind: "response",
      id: response.data.id,
      result: response.data.result,
    };
  }

  const errorResponse = hasError ? ResponseErrorFrameSchema.safeParse(parsed) : null;
  if (errorResponse?.success) {
    return {
      kind: "error-response",
      id: errorResponse.data.id,
      error: errorResponse.data.error,
    };
  }

  const event = EventFrameSchema.safeParse(parsed);
  if (event.success) {
    return {
      kind: "event",
      event: event.data.event,
      payload: event.data.payload,
    };
  }

  throw createSshError("server.protocol-error");
}

/**
 * Converts a remote server error frame to an Error while preserving its code.
 */
function errorFromServerFrame(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("Remote server request failed");
  }

  const message = typeof value.message === "string" ? value.message : "Remote server request failed";
  const error = new Error(message);
  if (typeof value.code === "string") {
    (error as Error & { code: string }).code = value.code;
  }
  return error;
}

/**
 * Creates a typed SSH transport error with no raw stderr attached.
 */
function createSshError(code: SshErrorCode, cause?: unknown): SshError {
  const error = new Error(messageForSshErrorCode(code), { cause }) as SshError;
  error.name = "SshError";
  (error as Error & { code: SshErrorCode }).code = code;
  return error;
}

/**
 * Creates the local disposal error used for abandoned ready/call waiters.
 */
function createDisposedError(): Error {
  const error = new Error("SSH channel disposed");
  error.name = "AbortError";
  return error;
}

/**
 * Maps stable SSH error codes to non-sensitive caller-facing messages.
 */
function messageForSshErrorCode(code: SshErrorCode): string {
  switch (code) {
    case "ssh.connect-failed":
      return "SSH connection failed";
    case "ssh.auth-failed":
      return "SSH authentication failed";
    case "server.spawn-failed":
      return "Remote server failed to start";
    case "server.protocol-error":
      return "Remote server protocol error";
    case "ssh.unknown":
      return "SSH transport failed";
  }
}

/**
 * Narrows unknown JSON values to object records.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Distinguishes absent keys from keys present with an explicit undefined value.
 */
function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

/**
 * Builds a reusable line splitter for stdout/stderr chunk streams.
 */
function createLineSplitter(onLine: (line: string) => void): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  let buffer = "";

  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length === 0) return;
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      onLine(line);
    },
  };
}
