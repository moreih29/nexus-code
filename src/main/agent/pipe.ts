/**
 * NDJSON request/response/event state machine over an arbitrary stdio triple
 * (stdin / stdout / stderr). Used by both `ssh-channel` (over an SSH-tunneled
 * child) and `local-channel` (over a locally spawned agent child) — the
 * channel layer above owns process lifecycle and supplies a stderr classifier.
 *
 * The error code currency on this file is still `SshErrorCode` for historical
 * reasons; the `server.*` codes apply equally to local and the SSH-specific
 * codes (`ssh.connect-failed`, `ssh.auth-failed`) are simply never produced by
 * a local classifier. A future refactor may split the enum, but the channel
 * layer can already translate at its boundary today.
 */
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { PendingRequestMap } from "../../shared/pending-request-map";
import type { SshErrorCode } from "../../shared/types/ssh-errors";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const ReadyFrameSchema = z
  .object({ type: z.literal("ready"), protocolVersion: z.string().optional() })
  .passthrough();
const ResponseResultFrameSchema = z.object({ id: z.string(), result: z.unknown() }).passthrough();
const ResponseErrorFrameSchema = z.object({ id: z.string(), error: z.unknown() }).passthrough();
const EventFrameSchema = z
  .object({ event: z.string(), payload: z.unknown().optional() })
  .passthrough();

type ParsedFrame =
  | { kind: "ready"; protocolVersion?: string }
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error-response"; id: string; error: unknown }
  | { kind: "event"; event: string; payload: unknown };

export interface SshError extends Error {
  readonly code: SshErrorCode;
}

export type NdjsonEventCallback = (payload: unknown) => void;
export type StderrClassifier = (line: string) => SshErrorCode | null;

export interface NdjsonPipeDependencies {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly stdin: Writable;
  readonly classifyStderr: StderrClassifier;
  readonly onTerminalError: (error: SshError) => void;
  readonly requestTimeoutMs?: number;
  readonly expectedProtocolMajor?: string;
}

export interface NdjsonPipe {
  readonly ready: Promise<void>;
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  on(event: string, callback: NdjsonEventCallback): () => void;
  /** Local cleanup — rejects ready/inflight, clears listeners. Owner kills the child. */
  dispose(): void;
  /** Marks the pipe terminally failed from the orchestrator's side. */
  fail(error: Error): void;
  /** Flushes buffered lines and reports whether ready had settled before close. */
  notifyClose(): { wasReady: boolean };
}

/**
 * Creates the NDJSON request/response/event state machine over a stdio triple.
 * Owns frame parsing, pending-request matching, and stderr classification —
 * but not process lifecycle (spawn/kill/timers), which the orchestrator owns.
 */
export function createNdjsonPipe(deps: NdjsonPipeDependencies): NdjsonPipe {
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const expectedProtocolMajor = deps.expectedProtocolMajor ?? "1";
  const pendingRequests = new PendingRequestMap<string, unknown>();
  const activeRequestIds = new Set<string>();
  const listeners = new Map<string, Set<NdjsonEventCallback>>();
  const stdoutLines = createLineSplitter(handleStdoutLine);
  const stderrLines = createLineSplitter(handleStderrLine);

  let nextRequestId = 1;
  let disposed = false;
  let terminalError: Error | null = null;
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

  /** Records a terminal pipe failure detected from stream data. */
  function selfFail(error: SshError): void {
    if (terminalError) return;
    terminalError = error;
    rejectReady(error);
    rejectPendingRequests(error);
    deps.onTerminalError(error);
  }

  /** Parses one stdout NDJSON line and routes it to ready, call, or event state. */
  function handleStdoutLine(line: string): void {
    if (disposed || terminalError || line.length === 0) return;

    let frame: ParsedFrame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      selfFail(createSshError("server.protocol-error", error));
      return;
    }

    if (frame.kind === "ready") {
      if (!protocolMajorMatches(frame.protocolVersion, expectedProtocolMajor)) {
        selfFail(createSshError("server.protocol-version-mismatch"));
        return;
      }
      resolveReady();
      return;
    }

    resolveReady();
    if (frame.kind === "response") {
      if (!activeRequestIds.has(frame.id)) {
        selfFail(createSshError("server.protocol-error"));
        return;
      }
      pendingRequests.resolve(frame.id, frame.result);
      return;
    }

    if (frame.kind === "error-response") {
      if (!activeRequestIds.has(frame.id)) {
        selfFail(createSshError("server.protocol-error"));
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

    const code = deps.classifyStderr(line);
    if (code) {
      selfFail(createSshError(code));
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

  deps.stdout.on("data", (chunk: Buffer) => {
    stdoutLines.push(chunk);
  });

  deps.stderr.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk);
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

      const requestId = `r-${nextRequestId++}`;
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

      if (!deps.stdin.writable || deps.stdin.destroyed) {
        pendingRequests.reject(requestId, createSshError("ssh.unknown"));
        return promise;
      }

      deps.stdin.write(line, (error) => {
        if (error) {
          pendingRequests.reject(requestId, createSshError("ssh.unknown", error));
        }
      });

      return promise;
    },
    on(event: string, callback: NdjsonEventCallback): () => void {
      let callbacks = listeners.get(event);
      if (!callbacks) {
        callbacks = new Set<NdjsonEventCallback>();
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const error = createDisposedError();
      rejectReady(error);
      rejectPendingRequests(error);
      listeners.clear();
    },
    fail(error: Error): void {
      if (terminalError) return;
      terminalError = error;
      rejectReady(error);
      rejectPendingRequests(error);
    },
    notifyClose(): { wasReady: boolean } {
      stdoutLines.flush();
      stderrLines.flush();
      return { wasReady: readySettled };
    },
  };
}

// === error helpers (exported for orchestrator use) ===

/**
 * Creates a typed SSH transport error with no raw stderr attached.
 */
export function createSshError(code: SshErrorCode, cause?: unknown): SshError {
  const error = new Error(messageForSshErrorCode(code), { cause }) as SshError;
  error.name = "SshError";
  (error as Error & { code: SshErrorCode }).code = code;
  return error;
}

/**
 * Creates the local disposal error used for abandoned ready/call waiters.
 */
export function createDisposedError(): Error {
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
      return "Remote agent failed to start";
    case "server.protocol-error":
      return "Remote agent protocol error";
    case "server.protocol-version-mismatch":
      return "Remote agent protocol version mismatch";
    case "ssh.unknown":
      return "SSH transport failed";
  }
}

// === frame parsing ===

/**
 * Parses exactly one NDJSON frame from stdout.
 */
function parseFrame(line: string): ParsedFrame {
  const parsed: unknown = JSON.parse(line);

  const ready = ReadyFrameSchema.safeParse(parsed);
  if (ready.success) {
    return { kind: "ready", protocolVersion: ready.data.protocolVersion };
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
 * Converts a remote agent error frame to an Error while preserving its code.
 */
function errorFromServerFrame(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("Remote agent request failed");
  }

  const message =
    typeof value.message === "string" ? value.message : "Remote agent request failed";
  const error = new Error(message);
  if (typeof value.code === "string") {
    (error as Error & { code: string }).code = value.code;
  }
  return error;
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

function protocolMajorMatches(actual: string | undefined, expectedMajor: string): boolean {
  if (actual === undefined) return true;
  return actual.split(".", 1)[0] === expectedMajor;
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
