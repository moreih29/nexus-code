import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { safeText } from "../../../../shared/log/limit";
import { createLogger } from "../../../../shared/log/main";
import type { StderrClassifier } from "../pipe";
import { AgentLineTooLongError, createNdjsonPipe, type NdjsonPipe, type SshError } from "../pipe";
import { ChannelEventRegistry } from "./event-registry";
import type {
  AgentCallOptions,
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "./index";

let channelLogger: ReturnType<typeof createLogger> | null = null;
function getChannelLogger(): ReturnType<typeof createLogger> {
  if (channelLogger === null) {
    channelLogger = createLogger("agent-channel");
  }
  return channelLogger;
}

const CLOSE_LOG_STDERR_TAIL_CHARS = 300;

const AGENT_READY_TIMEOUT_MS = 30_000;
const DISPOSE_KILL_GRACE_MS = 100;
const DEFAULT_MAX_PENDING_RECONNECT_CALLS = 32;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_CALL_TIMEOUT_MS = 30_000;
const MAX_CONSECUTIVE_FATAL_RECONNECT_FAILURES = 3;

const AGENT_PREEMPTED_EVENT = "agent.preempted";

export interface AgentReconnectOptions {
  readonly maxPendingCalls?: number;
  readonly callTimeoutMs?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface ChannelCloseContext {
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrTail?: string;
}

export interface ReconnectingProcessChannelOptions {
  readonly spawn: () => ChildProcessWithoutNullStreams;
  readonly disposeChild?: (child: ChildProcessWithoutNullStreams) => void;
  readonly classifyStderr: StderrClassifier;
  readonly closeError: (wasReady: boolean, context?: ChannelCloseContext) => Error;
  readonly logLabel?: string;
  readonly requestTimeoutMs?: number;
  readonly expectedProtocolMajor?: string;
  readonly reconnect?: AgentReconnectOptions;
  readonly isFatalReconnectError?: (error: SshError) => boolean;
}

interface ActiveProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pipe: NdjsonPipe;
  closed: boolean;
  ready: boolean;
  preempted: boolean;
  reconnectAfterClose?: SshError;
  forceKillTimer: NodeJS.Timeout | null;
}

interface QueuedCall {
  readonly method: string;
  readonly params: unknown;
  readonly options?: AgentCallOptions;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

type ChannelState = "connecting" | "ready" | "reconnecting" | "terminal" | "disposed";

export function createReconnectingProcessChannel(
  options: ReconnectingProcessChannelOptions,
): AgentChannel {
  const lifecycleListeners = new Set<ChannelLifecycleCallback>();
  const events = new ChannelEventRegistry();
  const queue: QueuedCall[] = [];
  const reconnect = normalizeReconnectOptions(options.reconnect, options.requestTimeoutMs);
  const label = options.logLabel ?? "agent";

  let active: ActiveProcess | null = null;
  let state: ChannelState = "connecting";
  let terminalError: Error | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let nextReconnectDelayMs = reconnect.initialDelayMs;
  let consecutiveFatalFailures = 0;
  let lastAgentEpoch = 0;

  const first = spawnAttempt("connecting");
  const ready = first.pipe.ready;
  ready.catch(() => {});

  return {
    ready,
    call<TResult = unknown>(
      method: string,
      params?: unknown,
      options?: AgentCallOptions,
    ): Promise<TResult> {
      if (state === "disposed") return Promise.reject(createDisposedErrorForChannel());
      if (terminalError) return Promise.reject(terminalError);
      if (state === "reconnecting") return enqueueCall<TResult>(method, params, options);
      if (!active) return Promise.reject(createAgentReconnectError("agent.reconnect-unavailable"));
      return active.pipe.call<TResult>(method, params, options);
    },
    fire(method: string, params?: unknown): void {
      if (state === "disposed" || terminalError || state === "reconnecting" || !active) return;
      active.pipe.fire(method, params);
    },
    on(event: string, callback: ChannelEventCallback): () => void {
      return events.subscribe(event, callback, (e) => attachPipeEvent(active?.pipe ?? null, e));
    },
    onLifecycle(callback: ChannelLifecycleCallback): () => void {
      lifecycleListeners.add(callback);
      return () => {
        lifecycleListeners.delete(callback);
      };
    },
    dispose(): void {
      if (state === "disposed") return;
      getChannelLogger().info(
        `[${label}] channel disposed (pid=${active?.child.pid}, state=${state})`,
      );
      state = "disposed";
      clearReconnectTimer();
      rejectQueuedCalls(createDisposedErrorForChannel());
      active?.pipe.dispose();
      if (active && !active.child.stdin.destroyed) active.child.stdin.end();
      if (!terminalError) emitLifecycle({ type: "disposed" });
      if (active && !active.closed) {
        if (options.disposeChild) options.disposeChild(active.child);
        else terminateChild(active);
      }
    },
  };

  function spawnAttempt(phase: "connecting" | "reconnecting"): ActiveProcess {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawn();
    } catch (error) {
      getChannelLogger().warn(
        `[${label}] spawn threw (phase=${phase}): ${safeText(error instanceof Error ? error.message : String(error), 300)}`,
      );
      const wrapped = createAgentReconnectError("agent.reconnect-unavailable", error);
      if (phase === "connecting") {
        state = "terminal";
        terminalError = wrapped;
      } else {
        scheduleReconnect();
      }
      throw wrapped;
    }
    getChannelLogger().info(`[${label}] agent child spawned (phase=${phase}, pid=${child.pid})`);

    let attempt!: ActiveProcess;
    const pipe = createNdjsonPipe({
      stdout: child.stdout,
      stderr: child.stderr,
      stdin: child.stdin,
      classifyStderr: options.classifyStderr,
      onTerminalError: (error, wasReady) => handlePipeFailure(attempt, error, phase, wasReady),
      requestTimeoutMs: options.requestTimeoutMs,
      readyTimeoutMs: AGENT_READY_TIMEOUT_MS,
      expectedProtocolMajor: options.expectedProtocolMajor,
      onDegraded: () => {
        if (state === "disposed" || active !== attempt) return;
        emitLifecycle({ type: "degraded" });
      },
      onDegradedRecovered: () => {
        if (state === "disposed" || active !== attempt) return;
        emitLifecycle({ type: "degraded-recovered" });
      },
    });
    attempt = {
      child,
      pipe,
      closed: false,
      ready: false,
      preempted: false,
      forceKillTimer: null,
    };
    active = attempt;
    attachAllEvents(attempt.pipe);
    pipe.on(AGENT_PREEMPTED_EVENT, () => {
      attempt.preempted = true;
    });

    attempt.pipe.ready
      .then(() => {
        if (state === "disposed" || active !== attempt) return;
        attempt.ready = true;
        state = "ready";
        nextReconnectDelayMs = reconnect.initialDelayMs;
        consecutiveFatalFailures = 0;

        const newEpoch = attempt.pipe.agentEpoch ?? 0;
        getChannelLogger().info(
          `[${label}] agent ready (phase=${phase}, pid=${attempt.child.pid}, epoch=${newEpoch})`,
        );
        if (phase === "reconnecting" && lastAgentEpoch !== 0 && newEpoch !== 0) {
          if (newEpoch !== lastAgentEpoch) {
            const previousEpoch = lastAgentEpoch;
            lastAgentEpoch = newEpoch;
            getChannelLogger().warn(
              `[${label}] daemon replaced during outage (epoch ${previousEpoch} -> ${newEpoch}); rejecting reconnect queue`,
            );
            rejectQueuedCalls(createAgentReconnectError("agent.reconnect-unavailable"));
            emitLifecycle({ type: "held-then-expired", previousEpoch, newEpoch });
            return;
          }
          lastAgentEpoch = newEpoch;
          flushQueuedCalls();
          emitLifecycle({ type: "ready" });
          return;
        }
        lastAgentEpoch = newEpoch;
        flushQueuedCalls();
        if (phase === "reconnecting") {
          emitLifecycle({ type: "ready" });
        }
      })
      .catch((error) => {
        if (state === "disposed" || active !== attempt) return;
        getChannelLogger().warn(
          `[${label}] agent handshake failed (phase=${phase}, pid=${attempt.child.pid}): ${safeText(error instanceof Error ? error.message : String(error), 300)}`,
        );
        if (phase === "reconnecting") {
          scheduleReconnect();
          return;
        }
        state = "terminal";
        terminalError = error instanceof Error ? error : options.closeError(false);
      });

    child.on("error", (error) => handleSpawnError(attempt, error, phase));
    child.on("close", (code, signal) => handleClose(attempt, code, signal, phase));
    return attempt;
  }

  function handlePipeFailure(
    attempt: ActiveProcess,
    error: SshError,
    phase: "connecting" | "reconnecting",
    wasReady: boolean,
  ): void {
    if (state === "disposed" || active !== attempt) return;
    getChannelLogger().warn(
      `[${label}] agent pipe failure (phase=${phase}, pid=${attempt.child.pid}, code=${error.code}): ${safeText(error.message, 300)}`,
    );
    if (wasReady && error.cause instanceof AgentLineTooLongError) {
      attempt.reconnectAfterClose = error;
      terminateChild(attempt);
      return;
    }
    if (!attempt.ready && error.code === "transport.timeout") attempt.child.kill("SIGKILL");
    else terminateChild(attempt);
    if (phase === "reconnecting") {
      if (options.isFatalReconnectError?.(error)) {
        consecutiveFatalFailures += 1;
        if (consecutiveFatalFailures >= MAX_CONSECUTIVE_FATAL_RECONNECT_FAILURES) {
          escalateReconnectFailure(error);
          return;
        }
      } else {
        consecutiveFatalFailures = 0;
      }
      scheduleReconnect();
      return;
    }
    state = "terminal";
    terminalError = error;
    emitLifecycle({ type: "failure", error });
  }

  function escalateReconnectFailure(error: SshError): void {
    getChannelLogger().warn(
      `[${label}] giving up reconnect after ${consecutiveFatalFailures} consecutive fatal failures (code=${error.code})`,
    );
    clearReconnectTimer();
    state = "terminal";
    terminalError = error;
    rejectQueuedCalls(error);
    emitLifecycle({ type: "failure", error });
  }

  function handleSpawnError(
    attempt: ActiveProcess,
    error: unknown,
    phase: "connecting" | "reconnecting",
  ): void {
    if (state === "disposed" || active !== attempt) return;
    getChannelLogger().warn(
      `[${label}] agent spawn error (phase=${phase}, pid=${attempt.child.pid}): ${safeText(error instanceof Error ? error.message : String(error), 300)}`,
    );
    const wrapped =
      phase === "connecting"
        ? options.closeError(false)
        : createAgentReconnectError("agent.reconnect-unavailable", error);
    attempt.pipe.fail(wrapped);
    if (phase === "reconnecting") {
      scheduleReconnect();
      return;
    }
    state = "terminal";
    terminalError = wrapped;
    emitLifecycle({ type: "failure", error: wrapped });
  }

  function handleClose(
    attempt: ActiveProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    phase: "connecting" | "reconnecting",
  ): void {
    if (active !== attempt) return;
    attempt.closed = true;
    clearForceKillTimer(attempt);
    const { wasReady, stderrTail } = attempt.pipe.notifyClose();
    const closeContext: ChannelCloseContext = { code, signal, stderrTail };
    const tail = safeText(stderrTail.trim(), CLOSE_LOG_STDERR_TAIL_CHARS);
    getChannelLogger().warn(
      `[${label}] agent child closed (phase=${phase}, pid=${attempt.child.pid}, code=${code}, signal=${signal}, wasReady=${wasReady}, state=${state})${tail ? ` stderr=${tail}` : ""}`,
    );

    if (state === "disposed" || terminalError) return;
    if (wasReady && (attempt.preempted || (code === 0 && !attempt.reconnectAfterClose))) {
      getChannelLogger().info(
        attempt.preempted
          ? `[${label}] another connection took the agent over; channel is now terminal`
          : `[${label}] clean agent exit; channel is now terminal`,
      );
      state = "terminal";
      terminalError = options.closeError(true, closeContext);
      emitLifecycle({ type: "exit", code, signal });
      return;
    }

    if (wasReady || phase === "reconnecting") {
      attempt.pipe.fail(createAgentReconnectError("agent.reconnect-in-progress"));
      const wasAlreadyReconnecting = state === "reconnecting";
      state = "reconnecting";
      scheduleReconnect();
      if (!wasAlreadyReconnecting) {
        emitLifecycle({
          type: "reconnecting",
          cause:
            attempt.reconnectAfterClose ??
            (code === null ? null : new Error(`agent process exited with code ${code}`)),
          hadEpoch: lastAgentEpoch !== 0,
        });
      }
      return;
    }

    getChannelLogger().warn(`[${label}] agent closed before first ready; channel failure`);
    const error = options.closeError(wasReady, closeContext);
    attempt.pipe.fail(error);
    state = "terminal";
    terminalError = error;
    emitLifecycle({ type: "failure", error });
  }

  function enqueueCall<TResult>(
    method: string,
    params: unknown,
    options: AgentCallOptions | undefined,
  ): Promise<TResult> {
    if (queue.length >= reconnect.maxPendingCalls) {
      return Promise.reject(createAgentReconnectError("agent.reconnect-queue-overflow"));
    }

    return new Promise<TResult>((resolve, reject) => {
      const queued: QueuedCall = {
        method,
        params,
        options,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: setTimeout(() => {
          removeQueuedCall(queued);
          reject(createAgentReconnectError("agent.reconnect-timeout"));
        }, reconnect.callTimeoutMs),
      };
      queued.timer.unref?.();
      queue.push(queued);
    });
  }

  function flushQueuedCalls(): void {
    const pipe = active?.pipe;
    if (!pipe) return;
    for (const call of queue.splice(0)) {
      clearTimeout(call.timer);
      pipe.call(call.method, call.params, call.options).then(call.resolve, call.reject);
    }
  }

  function rejectQueuedCalls(error: Error): void {
    for (const call of queue.splice(0)) {
      clearTimeout(call.timer);
      call.reject(error);
    }
  }

  function removeQueuedCall(call: QueuedCall): void {
    const index = queue.indexOf(call);
    if (index >= 0) queue.splice(index, 1);
  }

  function scheduleReconnect(): void {
    if (state === "disposed" || terminalError || reconnectTimer) return;
    getChannelLogger().info(`[${label}] scheduling agent respawn in ${nextReconnectDelayMs}ms`);
    state = "reconnecting";
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (state === "disposed") return;
      try {
        spawnAttempt("reconnecting");
      } catch {}
    }, nextReconnectDelayMs);
    reconnectTimer.unref?.();
    nextReconnectDelayMs = Math.min(nextReconnectDelayMs * 2, reconnect.maxDelayMs);
  }

  function attachAllEvents(pipe: NdjsonPipe): void {
    events.rebind((event) => attachPipeEvent(pipe, event));
  }

  function attachPipeEvent(pipe: NdjsonPipe | null, event: string): (() => void) | null {
    if (!pipe) return null;
    return pipe.on(event, (payload) => events.emit(event, payload));
  }

  function terminateChild(attempt: ActiveProcess): void {
    if (attempt.closed || attempt.child.killed) return;
    attempt.child.kill("SIGTERM");
    scheduleForceKill(attempt);
  }

  function scheduleForceKill(attempt: ActiveProcess): void {
    if (attempt.forceKillTimer) return;
    attempt.forceKillTimer = setTimeout(() => {
      attempt.child.kill("SIGKILL");
    }, DISPOSE_KILL_GRACE_MS);
    attempt.forceKillTimer.unref?.();
  }

  function clearForceKillTimer(attempt: ActiveProcess): void {
    if (!attempt.forceKillTimer) return;
    clearTimeout(attempt.forceKillTimer);
    attempt.forceKillTimer = null;
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  }
}

function normalizeReconnectOptions(
  options: AgentReconnectOptions | undefined,
  requestTimeoutMs: number | undefined,
): Required<AgentReconnectOptions> {
  return {
    maxPendingCalls: options?.maxPendingCalls ?? DEFAULT_MAX_PENDING_RECONNECT_CALLS,
    callTimeoutMs: options?.callTimeoutMs ?? requestTimeoutMs ?? DEFAULT_RECONNECT_CALL_TIMEOUT_MS,
    initialDelayMs: options?.initialDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    maxDelayMs: options?.maxDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
  };
}

export type AgentReconnectErrorCode =
  | "agent.reconnect-in-progress"
  | "agent.reconnect-queue-overflow"
  | "agent.reconnect-timeout"
  | "agent.reconnect-unavailable";

export interface AgentReconnectError extends Error {
  readonly code: AgentReconnectErrorCode;
  readonly retryable: true;
}

export function createAgentReconnectError(
  code: AgentReconnectErrorCode,
  cause?: unknown,
): AgentReconnectError {
  const error = new Error(messageForReconnectCode(code), { cause }) as AgentReconnectError;
  error.name = "AgentReconnectError";
  (error as Error & { code: AgentReconnectErrorCode }).code = code;
  (error as Error & { retryable: true }).retryable = true;
  return error;
}

function createDisposedErrorForChannel(): Error {
  const error = new Error("SSH channel disposed");
  error.name = "AbortError";
  return error;
}

function messageForReconnectCode(code: AgentReconnectErrorCode): string {
  switch (code) {
    case "agent.reconnect-in-progress":
      return "Agent reconnect in progress";
    case "agent.reconnect-queue-overflow":
      return "Agent reconnect queue is full";
    case "agent.reconnect-timeout":
      return "Agent reconnect timed out";
    case "agent.reconnect-unavailable":
      return "Agent reconnect unavailable";
  }
}
