import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { NumberSchema } from "../../../../packages/remote-protocol/src/validation";
import { AGENT_PROTOCOL_VERSION } from "../../../shared/agent/envelope";
import { PendingRequestMap } from "../../../shared/ipc/pending-request-map";
import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";
import type { LogLevel } from "../../../shared/log/types";
import type { SshErrorCode } from "../../../shared/ssh/errors";
import { heartbeatHistogramLine } from "./heartbeat-histogram";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_AGENT_LINE_BYTES = 64 * 1024 * 1024;

export class AgentLineTooLongError extends Error {
  constructor() {
    super(`Agent output line exceeded ${MAX_AGENT_LINE_BYTES} bytes`);
  }
}
const ABANDONED_REQUEST_IDS_MAX = 1024;

const AGENT_LOG_SRC_MARKER = "agent-log";

let agentFacadeLogger: ReturnType<typeof createLogger> | null = null;
function getAgentLogger(): ReturnType<typeof createLogger> {
  if (agentFacadeLogger === null) {
    agentFacadeLogger = createLogger("agent");
  }
  return agentFacadeLogger;
}

interface AgentLogRecord {
  src: typeof AGENT_LOG_SRC_MARKER;
  level?: string;
  msg?: string;
  correlationId?: string;
}

function isAgentLogRecord(value: unknown): value is AgentLogRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).src === AGENT_LOG_SRC_MARKER
  );
}

function slogLevelToFacade(level: string | undefined): LogLevel {
  switch (level?.toUpperCase()) {
    case "DEBUG":
      return "debug";
    case "WARN":
    case "WARNING":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return "info";
  }
}

const STDOUT_BACKPRESSURE_HWM = 1 * 1024 * 1024;

const STDOUT_BACKPRESSURE_LWM = 64 * 1024;

const AGENT_HEARTBEAT_EVENT = "agent.heartbeat";

const KEEPALIVE_PING_SLOTS = 6;

const ReadyFrameSchema = z.looseObject({
  type: z.literal("ready"),
  protocolVersion: z.string().optional(),
  methods: z.array(z.string()).optional(),
  heartbeatIntervalMs: NumberSchema.optional(),
  idleWatchdogMs: NumberSchema.optional(),
  agentEpoch: NumberSchema.optional(),
  capabilities: z.array(z.string()).optional(),
});
const ResponseResultFrameSchema = z.looseObject({ id: z.string(), result: z.unknown().optional() });
const ResponseErrorFrameSchema = z.looseObject({ id: z.string(), error: z.unknown().optional() });
const EventFrameSchema = z.looseObject({ event: z.string(), payload: z.unknown().optional() });

type ParsedFrame =
  | {
      kind: "ready";
      protocolVersion?: string;
      methods?: string[];
      heartbeatIntervalMs?: number;
      idleWatchdogMs?: number;
      agentEpoch?: number;
      capabilities?: string[];
    }
  | { kind: "response"; id: string; result: unknown }
  | { kind: "error-response"; id: string; error: unknown }
  | { kind: "event"; event: string; payload: unknown };

export interface NdjsonCallOptions {
  readonly correlationId?: string;
  readonly timeoutMs?: number;
}

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
  readonly onTerminalError: (error: SshError, wasReady: boolean) => void;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly expectedProtocolMajor?: string;
  readonly onDegraded?: () => void;
  readonly onDegradedRecovered?: () => void;
}

export interface NdjsonPipe {
  readonly ready: Promise<void>;
  readonly methods?: readonly string[];
  readonly heartbeatIntervalMs?: number;
  readonly agentEpoch?: number;
  call<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: NdjsonCallOptions,
  ): Promise<TResult>;
  fire(method: string, params?: unknown): void;
  on(event: string, callback: NdjsonEventCallback): () => void;
  dispose(): void;
  fail(error: Error): void;
  notifyClose(): { wasReady: boolean; stderrTail: string };
}

export function createNdjsonPipe(deps: NdjsonPipeDependencies): NdjsonPipe {
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const expectedProtocolMajor = deps.expectedProtocolMajor ?? AGENT_PROTOCOL_VERSION;
  const pendingRequests = new PendingRequestMap<string, unknown>();
  const activeRequestIds = new Set<string>();
  const abandonedRequestIds = new Set<string>();
  const listeners = new Map<string, Set<NdjsonEventCallback>>();
  const onLineTooLong = () =>
    selfFail(createSshError("server.protocol-error", new AgentLineTooLongError()));
  const stdoutLines = createLineSplitter(handleStdoutLine, onLineTooLong, {
    hwm: STDOUT_BACKPRESSURE_HWM,
    lwm: STDOUT_BACKPRESSURE_LWM,
    pause: () => deps.stdout.pause(),
    resume: () => deps.stdout.resume(),
  });
  const stderrLines = createLineSplitter(handleStderrLine, onLineTooLong);

  const STDERR_TAIL_MAX_LINES = 20;
  const STDERR_TAIL_MAX_LINE_CHARS = 200;
  const recentStderr: string[] = [];
  let deferredSpawnFailure: string | null = null;

  let nextRequestId = 1;
  let disposed = false;
  let terminalError: Error | null = null;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  let readyReceived = false;
  let readyTimer: NodeJS.Timeout | undefined;

  let capabilityMethods: readonly string[] | undefined;
  let capabilityHeartbeatIntervalMs: number | undefined;
  let capabilityAgentEpoch: number | undefined;

  let lastHeartbeatAt = 0;
  let heartbeatWarned = false;
  let heartbeatWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  let isDegraded = false;

  const HISTOGRAM_BUCKETS = 11;
  const heartbeatHistogram = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  let histogramIntervalMs = 0;
  let histogramLogTimer: ReturnType<typeof setInterval> | null = null;

  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = () => {
      if (readySettled) return;
      readySettled = true;
      readyReceived = true;
      clearTimeout(readyTimer);
      resolve();
    };
    rejectReady = (error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimer);
      reject(error);
    };
  });
  ready.catch(() => {});

  function clearHeartbeatWatchdog(): void {
    if (heartbeatWatchdogTimer !== null) {
      clearInterval(heartbeatWatchdogTimer);
      heartbeatWatchdogTimer = null;
    }
    if (histogramLogTimer !== null) {
      clearInterval(histogramLogTimer);
      histogramLogTimer = null;
    }
    lastHeartbeatAt = 0;
    heartbeatWarned = false;
    isDegraded = false;
  }

  function clearKeepalive(): void {
    if (keepaliveTimer !== null) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function rejectPendingRequests(error: Error): void {
    for (const requestId of Array.from(activeRequestIds)) {
      pendingRequests.reject(requestId, error);
    }
    activeRequestIds.clear();
  }

  function selfFail(error: SshError): void {
    if (disposed || terminalError) return;
    terminalError = error;
    clearHeartbeatWatchdog();
    clearKeepalive();
    rejectReady(error);
    rejectPendingRequests(error);
    deps.onTerminalError(error, readyReceived);
  }

  function handleStdoutLine(line: string): void {
    if (disposed || terminalError || line.length === 0) return;

    let frame: ParsedFrame;
    try {
      frame = parseFrame(line);
    } catch (error) {
      logMalformedStdoutLine(line, readySettled, error);
      selfFail(createSshError("server.protocol-error", error));
      return;
    }

    if (frame.kind === "ready") {
      if (!protocolMajorMatches(frame.protocolVersion, expectedProtocolMajor)) {
        selfFail(createSshError("server.protocol-version-mismatch"));
        return;
      }
      if (frame.methods !== undefined) {
        capabilityMethods = frame.methods;
      }
      if (frame.heartbeatIntervalMs !== undefined) {
        capabilityHeartbeatIntervalMs = frame.heartbeatIntervalMs;
      }
      if (frame.agentEpoch !== undefined) {
        capabilityAgentEpoch = frame.agentEpoch;
      }
      if (frame.heartbeatIntervalMs !== undefined && frame.heartbeatIntervalMs > 0) {
        const intervalMs = frame.heartbeatIntervalMs;
        const degradedThresholdMs = intervalMs * 1;
        const watchdogIntervalMs = intervalMs * 3;
        lastHeartbeatAt = Date.now();
        const timer = setInterval(() => {
          if (disposed || terminalError) return;
          const elapsed = Date.now() - lastHeartbeatAt;
          if (elapsed >= degradedThresholdMs && !isDegraded) {
            isDegraded = true;
            deps.onDegraded?.();
          }
          if (elapsed >= watchdogIntervalMs) {
            if (!heartbeatWarned) {
              heartbeatWarned = true;
              getMalformedStdoutLogger().warn(
                `heartbeat watchdog: no heartbeat received for >${watchdogIntervalMs}ms (interval=${intervalMs}ms, 3-miss policy)`,
              );
            }
          }
        }, degradedThresholdMs);
        if (typeof (timer as NodeJS.Timeout).unref === "function") {
          (timer as NodeJS.Timeout).unref();
        }
        heartbeatWatchdogTimer = timer;

        histogramIntervalMs = intervalMs;
        const logTimer = setInterval(() => {
          if (disposed || terminalError) return;
          const line = heartbeatHistogramLine(intervalMs, heartbeatHistogram);
          if (line !== null) getMalformedStdoutLogger().info(line);
          heartbeatHistogram.fill(0);
        }, 60_000);
        if (typeof (logTimer as NodeJS.Timeout).unref === "function") {
          (logTimer as NodeJS.Timeout).unref();
        }
        histogramLogTimer = logTimer;
      }

      if (frame.idleWatchdogMs !== undefined && frame.idleWatchdogMs > 0) {
        const pingIntervalMs = Math.max(1, Math.floor(frame.idleWatchdogMs / KEEPALIVE_PING_SLOTS));
        const ping = setInterval(() => {
          if (disposed || terminalError) return;
          pipe.fire("ping");
        }, pingIntervalMs);
        if (typeof (ping as NodeJS.Timeout).unref === "function") {
          (ping as NodeJS.Timeout).unref();
        }
        keepaliveTimer = ping;
      }
      resolveReady();
      return;
    }

    resolveReady();
    if (frame.kind === "response") {
      if (!activeRequestIds.has(frame.id)) {
        if (!abandonedRequestIds.delete(frame.id)) {
          selfFail(createSshError("server.protocol-error"));
        }
        return;
      }
      pendingRequests.resolve(frame.id, frame.result);
      return;
    }

    if (frame.kind === "error-response") {
      if (!activeRequestIds.has(frame.id)) {
        if (!abandonedRequestIds.delete(frame.id)) {
          selfFail(createSshError("server.protocol-error"));
        }
        return;
      }
      pendingRequests.reject(frame.id, errorFromServerFrame(frame.error));
      return;
    }

    if (frame.event === AGENT_HEARTBEAT_EVENT) {
      const now = Date.now();
      const elapsed = lastHeartbeatAt > 0 ? now - lastHeartbeatAt : 0;
      lastHeartbeatAt = now;
      heartbeatWarned = false;
      if (histogramIntervalMs > 0 && elapsed > 0) {
        const bucketIndex = Math.min(
          Math.floor(elapsed / histogramIntervalMs),
          HISTOGRAM_BUCKETS - 1,
        );
        heartbeatHistogram[bucketIndex] = (heartbeatHistogram[bucketIndex] ?? 0) + 1;
      }
      if (isDegraded) {
        isDegraded = false;
        deps.onDegradedRecovered?.();
      }
    }
    emitEvent(frame.event, frame.payload);
  }

  function handleStderrLine(line: string): void {
    if (disposed || terminalError || line.length === 0) return;

    if (line.charCodeAt(0) === 0x7b) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {}
      if (isAgentLogRecord(parsed)) {
        const log = getAgentLogger();
        const level = slogLevelToFacade(parsed.level);
        const msg = parsed.msg ?? "(no message)";
        const meta =
          parsed.correlationId !== undefined ? { correlationId: parsed.correlationId } : undefined;
        log[level](msg, meta);
        return;
      }
    }

    recordStderr(line);

    if (readySettled) return;

    const code = deps.classifyStderr(line);
    if (code === "server.spawn-failed") {
      deferredSpawnFailure = line;
      return;
    }
    if (code) {
      selfFail(createSshError(code, line));
    }
  }

  function recordStderr(line: string): void {
    recentStderr.push(redactLogSecrets(line).slice(0, STDERR_TAIL_MAX_LINE_CHARS));
    if (recentStderr.length > STDERR_TAIL_MAX_LINES) {
      recentStderr.shift();
    }
  }

  function emitEvent(event: string, payload: unknown): void {
    const callbacks = listeners.get(event);
    if (!callbacks) return;
    for (const callback of Array.from(callbacks)) {
      try {
        callback(payload);
      } catch (error) {
        getAgentLogger().error(
          `agent event listener for ${event} threw: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }
    }
  }

  deps.stdout.on("data", (chunk: Buffer) => {
    stdoutLines.push(chunk);
  });

  deps.stderr.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk);
  });

  const pipe: NdjsonPipe = {
    ready,
    get methods(): readonly string[] | undefined {
      return capabilityMethods;
    },
    get heartbeatIntervalMs(): number | undefined {
      return capabilityHeartbeatIntervalMs;
    },
    get agentEpoch(): number | undefined {
      return capabilityAgentEpoch;
    },
    call<TResult = unknown>(
      method: string,
      params?: unknown,
      options: NdjsonCallOptions = {},
    ): Promise<TResult> {
      const { correlationId } = options;
      const timeoutMs = options.timeoutMs ?? requestTimeoutMs;
      if (disposed) {
        return Promise.reject(createDisposedError());
      }
      if (terminalError) {
        return Promise.reject(terminalError);
      }

      const requestId = `r-${nextRequestId++}`;
      const frame: Record<string, unknown> = { id: requestId, method, params };
      if (correlationId !== undefined) {
        frame.correlationId = correlationId;
      }
      let line: string;
      try {
        line = `${JSON.stringify(frame)}\n`;
      } catch (error) {
        return Promise.reject(createSshError("server.protocol-error", error));
      }

      activeRequestIds.add(requestId);
      const promise = pendingRequests
        .register({
          key: requestId,
          timeoutMs,
          onTimeout: () => {
            abandonedRequestIds.add(requestId);
            if (abandonedRequestIds.size > ABANDONED_REQUEST_IDS_MAX) {
              const oldest = abandonedRequestIds.values().next().value;
              if (oldest !== undefined) abandonedRequestIds.delete(oldest);
            }
            return createSshError(
              "transport.timeout",
              new Error(`${method} timed out after ${timeoutMs}ms`),
            );
          },
        })
        .finally(() => {
          activeRequestIds.delete(requestId);
        }) as Promise<TResult>;

      if (!deps.stdin.writable || deps.stdin.destroyed) {
        pendingRequests.reject(requestId, createSshError("transport.unknown"));
        return promise;
      }

      deps.stdin.write(line, (error) => {
        if (error) {
          pendingRequests.reject(requestId, createSshError("transport.unknown", error));
        }
      });

      return promise;
    },
    fire(method: string, params?: unknown): void {
      if (disposed || terminalError) return;
      this.call(method, params).catch(() => {});
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
      clearHeartbeatWatchdog();
      clearKeepalive();
      const error = createDisposedError();
      rejectReady(error);
      rejectPendingRequests(error);
      listeners.clear();
    },
    fail(error: Error): void {
      if (terminalError) return;
      terminalError = error;
      clearHeartbeatWatchdog();
      clearKeepalive();
      rejectReady(error);
      rejectPendingRequests(error);
    },
    notifyClose(): { wasReady: boolean; stderrTail: string } {
      stdoutLines.flush();
      stderrLines.flush();
      const wasReady = readyReceived;
      if (!readySettled && deferredSpawnFailure !== null) {
        selfFail(createSshError("server.spawn-failed", deferredSpawnFailure));
      }
      return { wasReady, stderrTail: recentStderr.join(" | ") };
    },
  };
  const readyTimeoutMs = deps.readyTimeoutMs;
  if (readyTimeoutMs !== undefined && !readySettled) {
    readyTimer = setTimeout(() => {
      selfFail(
        createSshError(
          "transport.timeout",
          new Error(`Agent handshake exceeded ${readyTimeoutMs}ms`),
        ),
      );
    }, readyTimeoutMs);
    readyTimer.unref?.();
  }
  return pipe;
}

export function createSshError(code: SshErrorCode, cause?: unknown): SshError {
  const error = new Error(messageForSshErrorCode(code), { cause }) as SshError;
  error.name = "SshError";
  (error as Error & { code: SshErrorCode }).code = code;
  try {
    const causeMsg =
      cause instanceof Error ? cause.message : cause === undefined ? "" : String(cause);
    const causeSnippet = redactLogSecrets(causeMsg).slice(0, 600);
    const stack = redactLogSecrets(error.stack ?? "")
      .split("\n")
      .slice(1, 6)
      .join(" | ");
    getMalformedStdoutLogger().warn(
      `SshError throw: code=${code} cause=${causeSnippet} stack=${stack}`,
    );
  } catch {}
  return error;
}

export function createDisposedError(): Error {
  const error = new Error("SSH channel disposed");
  error.name = "AbortError";
  return error;
}

export function messageForSshErrorCode(code: SshErrorCode): string {
  switch (code) {
    case "ssh.connect-failed":
      return "SSH connection failed";
    case "ssh.auth-failed":
      return "SSH authentication failed";
    case "ssh.auth-cancelled":
      return "SSH authentication cancelled";
    case "ssh.session-expired":
      return "SSH browse session expired";
    case "ssh.path-not-found":
      return "Remote path not found";
    case "server.spawn-failed":
      return "Agent failed to start";
    case "server.protocol-error":
      return "Agent protocol error";
    case "server.protocol-version-mismatch":
      return "Agent protocol version mismatch";
    case "ssh.unknown":
      return "SSH transport failed";
    case "transport.unknown":
      return "Agent transport failed";
    case "transport.timeout":
      return "Agent request timed out";
  }
}

const MALFORMED_LINE_PREVIEW_CHARS = 256;

let malformedStdoutDiagnosticLogger: ReturnType<typeof createLogger> | null = null;
function getMalformedStdoutLogger(): ReturnType<typeof createLogger> {
  if (malformedStdoutDiagnosticLogger === null) {
    malformedStdoutDiagnosticLogger = createLogger("agent-pipe");
  }
  return malformedStdoutDiagnosticLogger;
}

function logMalformedStdoutLine(line: string, ready: boolean, error: unknown): void {
  const preview = malformedLinePreview(line);
  const reason = error instanceof SyntaxError ? error.name : redactLogSecrets(String(error));
  getMalformedStdoutLogger().warn(
    `stdout NDJSON parse failed (ready=${ready}, len=${line.length}, reason=${reason}): ${preview}`,
  );
}

function malformedLinePreview(line: string): string {
  const redacted = redactLogSecrets(line);
  const truncated = redacted.length > MALFORMED_LINE_PREVIEW_CHARS ? "…" : "";
  return escapeControlChars(redacted.slice(0, MALFORMED_LINE_PREVIEW_CHARS)) + truncated;
}

function escapeControlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    out += value[i];
  }
  return out;
}

function parseFrame(line: string): ParsedFrame {
  const parsed: unknown = JSON.parse(line);

  if (isRecord(parsed) && parsed.type === "ready") {
    const ready = ReadyFrameSchema.safeParse(parsed);
    if (ready.success) {
      return {
        kind: "ready",
        protocolVersion: ready.data.protocolVersion,
        methods: ready.data.methods,
        heartbeatIntervalMs: ready.data.heartbeatIntervalMs,
        idleWatchdogMs: ready.data.idleWatchdogMs,
        agentEpoch: ready.data.agentEpoch,
        capabilities: ready.data.capabilities,
      };
    }
  }

  if (!isRecord(parsed)) {
    getMalformedStdoutLogger().warn(
      `parseFrame: parsed value is not a record. line=${malformedLinePreview(line)}`,
    );
    throw createSshError("server.protocol-error");
  }

  const hasResult = hasOwnKey(parsed, "result");
  const hasError = hasOwnKey(parsed, "error");
  const hasEvent = hasOwnKey(parsed, "event");
  if (hasResult && hasError) {
    getMalformedStdoutLogger().warn(
      `parseFrame: frame has both result and error. line=${malformedLinePreview(line)}`,
    );
    throw createSshError("server.protocol-error");
  }

  if (!hasResult && !hasError && !hasEvent && typeof parsed.id === "string") {
    return { kind: "response", id: parsed.id, result: null };
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

  const event = hasEvent ? EventFrameSchema.safeParse(parsed) : null;
  if (event?.success) {
    return {
      kind: "event",
      event: event.data.event,
      payload: event.data.payload,
    };
  }

  getMalformedStdoutLogger().warn(
    `parseFrame: frame matched no known schema. hasResult=${hasResult} hasError=${hasError} hasEvent=${hasEvent} line=${malformedLinePreview(line)}`,
  );
  throw createSshError("server.protocol-error");
}

function errorFromServerFrame(value: unknown): Error {
  if (!isRecord(value)) {
    return new Error("Agent request failed");
  }

  const message = typeof value.message === "string" ? value.message : "Agent request failed";
  const error = new Error(message);
  if (typeof value.code === "string") {
    (error as Error & { code: string }).code = value.code;
  }
  if (value.data !== undefined) {
    (error as Error & { data: unknown }).data = value.data;
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function protocolMajorMatches(actual: string | undefined, expectedMajor: string): boolean {
  if (actual === undefined) return true;
  return actual.split(".", 1)[0] === expectedMajor;
}

interface LineSplitterBackpressure {
  hwm: number;
  lwm: number;
  pause(): void;
  resume(): void;
}

function createLineSplitter(
  onLine: (line: string) => void,
  onLineTooLong: () => void,
  backpressure?: LineSplitterBackpressure,
): {
  push(chunk: Buffer): void;
  flush(): void;
} {
  let pending: Buffer | undefined;
  let pendingBytes = 0;
  let oversized = false;
  let tally = 0;
  let paused = false;

  function dispatchLine(line: string): void {
    if (!backpressure) {
      onLine(line);
      return;
    }
    tally += line.length;
    let listenerError: unknown;
    try {
      onLine(line);
    } catch (err) {
      listenerError = err;
    }
    if (!paused && tally > backpressure.hwm) {
      paused = true;
      tally = 0;
      backpressure.pause();
    } else if (paused && tally <= backpressure.lwm) {
      paused = false;
      tally = 0;
      backpressure.resume();
    }
    if (listenerError !== undefined) {
      throw listenerError;
    }
  }

  function postBurstResumeCheck(): void {
    if (backpressure && paused && tally <= backpressure.lwm) {
      paused = false;
      tally = 0;
      backpressure.resume();
    }
  }

  function fits(bytes: number): boolean {
    if (pendingBytes + bytes <= MAX_AGENT_LINE_BYTES) return true;
    pending = undefined;
    pendingBytes = 0;
    oversized = true;
    onLineTooLong();
    return false;
  }

  function append(tail: Buffer): Buffer {
    const end = pendingBytes + tail.length;
    if (!pending || pending.length < end) {
      const capacity = Math.min(MAX_AGENT_LINE_BYTES, Math.max(end, (pending?.length ?? 64) * 2));
      const grown = Buffer.allocUnsafe(capacity);
      pending?.copy(grown, 0, 0, pendingBytes);
      pending = grown;
    }
    tail.copy(pending, pendingBytes);
    pendingBytes = end;
    return pending.subarray(0, end);
  }

  return {
    push(chunk) {
      if (oversized) return;
      let start = 0;
      let newlineIndex = chunk.indexOf(0x0a);
      while (newlineIndex !== -1) {
        const tail = chunk.subarray(start, newlineIndex);
        if (!fits(tail.length)) return;
        const bytes = pending ? append(tail) : tail;
        pending = undefined;
        pendingBytes = 0;
        start = newlineIndex + 1;
        try {
          dispatchLine(bytes.toString("utf8").replace(/\r$/, ""));
        } catch (err) {
          if (start < chunk.length && fits(chunk.length - start)) {
            append(chunk.subarray(start));
          }
          throw err;
        }
        newlineIndex = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.length) {
        if (!fits(chunk.length - start)) return;
        append(chunk.subarray(start));
      }
      postBurstResumeCheck();
    },
    flush() {
      if (!pending) {
        postBurstResumeCheck();
        return;
      }
      const line = pending.toString("utf8", 0, pendingBytes).replace(/\r$/, "");
      pending = undefined;
      pendingBytes = 0;
      dispatchLine(line);
      postBurstResumeCheck();
    },
  };
}
