import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createLogger } from "../../../../shared/log/main";
import type {
  AgentChannel,
  ChannelEventCallback,
  ChannelLifecycleCallback,
  ChannelLifecycleEvent,
} from "./index";
import { ChannelEventRegistry } from "./event-registry";
import type { StderrClassifier } from "../pipe";
import { createNdjsonPipe, type NdjsonPipe, type SshError } from "../pipe";

/**
 * Lazy logger bound to source "agent-channel". Created on first use so the
 * module can be imported in test environments without triggering
 * electron-log initialization (same pattern as pipe.ts's agent logger).
 *
 * Why this logging exists: an agent child can die and be transparently
 * respawned without any user-visible signal. The respawn wipes agent-side
 * state (fs/git watch registrations live in the agent process), so a silent
 * respawn is the prime suspect whenever push events stop while RPC keeps
 * working. Every lifecycle transition below leaves a main.log line with the
 * child pid + exit diagnostics so the "when and why did it respawn" question
 * is answerable after the fact. Both the local channel and the SSH channel
 * route through this file, so one logging site covers both transports.
 */
let channelLogger: ReturnType<typeof createLogger> | null = null;
function getChannelLogger(): ReturnType<typeof createLogger> {
  if (channelLogger === null) {
    channelLogger = createLogger("agent-channel");
  }
  return channelLogger;
}

/** Max chars of a child's stderr tail to embed in one close-diagnostic line. */
const CLOSE_LOG_STDERR_TAIL_CHARS = 300;

const DISPOSE_KILL_GRACE_MS = 100;
const DEFAULT_MAX_PENDING_RECONNECT_CALLS = 32;
const DEFAULT_RECONNECT_DELAY_MS = 100;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_CALL_TIMEOUT_MS = 30_000;
// Consecutive reconnect attempts failing with a caller-declared *fatal* error
// (see `isFatalReconnectError`) before the channel gives up and transitions to
// a terminal failure. 3 absorbs a one-off flake (e.g. a PAM hiccup) while
// stopping a deterministic failure — batch-mode auth against a dead
// ControlMaster — from respawning ssh every maxDelayMs forever.
const MAX_CONSECUTIVE_FATAL_RECONNECT_FAILURES = 3;

export interface AgentReconnectOptions {
  readonly maxPendingCalls?: number;
  readonly callTimeoutMs?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

/**
 * Diagnostic context captured at the moment a child process closes. Passed to
 * `closeError` so the resulting terminal error can record the exit code,
 * signal, and the tail of the process's stderr (e.g. a loader error) — making
 * the file log self-sufficient instead of an empty-cause `ssh.unknown`.
 */
export interface ChannelCloseContext {
  readonly code?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly stderrTail?: string;
}

export interface ReconnectingProcessChannelOptions {
  readonly spawn: () => ChildProcessWithoutNullStreams;
  readonly classifyStderr: StderrClassifier;
  readonly closeError: (wasReady: boolean, context?: ChannelCloseContext) => Error;
  /**
   * Channel identity prefix for lifecycle log lines (e.g. `local:/path/to/ws`
   * or `ssh:host`). Multiple workspaces each own a channel, so without this
   * the main.log lifecycle entries are unattributable. Defaults to "agent".
   */
  readonly logLabel?: string;
  readonly requestTimeoutMs?: number;
  readonly expectedProtocolMajor?: string;
  readonly reconnect?: AgentReconnectOptions;
  /**
   * Marks a reconnect-attempt error as deterministic — one that will fail
   * identically on every retry (e.g. `ssh.auth-failed` from a batch-mode
   * respawn that can never satisfy an interactive prompt). After
   * MAX_CONSECUTIVE_FATAL_RECONNECT_FAILURES such failures in a row the
   * channel stops retrying and emits a terminal `failure` lifecycle event.
   * Absent (or returning false) preserves the retry-forever behavior, which
   * is correct for transient transport loss.
   */
  readonly isFatalReconnectError?: (error: SshError) => boolean;
}

interface ActiveProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pipe: NdjsonPipe;
  closed: boolean;
  ready: boolean;
  forceKillTimer: NodeJS.Timeout | null;
}

interface QueuedCall {
  readonly method: string;
  readonly params: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason?: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

type ChannelState = "connecting" | "ready" | "reconnecting" | "terminal" | "disposed";

/**
 * Creates an agent channel whose process can be transparently respawned after
 * a post-ready crash. Calls made during the reconnect window are kept in a
 * bounded queue and replayed once the replacement agent completes handshake.
 */
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
  // agentEpoch from the last successful ready handshake. 0 = no epoch seen yet
  // (legacy agent or first connect). Compared on each reconnect to detect daemon
  // replacement ("held-then-expired").
  let lastAgentEpoch = 0;

  const first = spawnAttempt("connecting");
  const ready = first.pipe.ready;
  ready.catch(() => {});

  return {
    ready,
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult> {
      if (state === "disposed") return Promise.reject(createDisposedErrorForChannel());
      if (terminalError) return Promise.reject(terminalError);
      if (state === "reconnecting") return enqueueCall<TResult>(method, params);
      if (!active) return Promise.reject(createAgentReconnectError("agent.reconnect-unavailable"));
      return active.pipe.call<TResult>(method, params);
    },
    fire(method: string, params?: unknown): void {
      // Fire-and-forget: delegates to the pipe's fire() which writes the frame
      // and absorbs the ack without blocking.  During reconnect the notification
      // is silently dropped — LSP text-sync state will be rebuilt on the next
      // didOpen after the reconnect completes.
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
      if (active) terminateChild(active);
    },
  };

  /** Starts one process attempt and wires pipe/process lifecycle handlers. */
  function spawnAttempt(phase: "connecting" | "reconnecting"): ActiveProcess {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawn();
    } catch (error) {
      getChannelLogger().warn(
        `[${label}] spawn threw (phase=${phase}): ${error instanceof Error ? error.message : String(error)}`,
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
      onTerminalError: (error) => handlePipeFailure(attempt, error, phase),
      requestTimeoutMs: options.requestTimeoutMs,
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
      forceKillTimer: null,
    };
    active = attempt;
    attachAllEvents(attempt.pipe);

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
            // Epoch mismatch: the daemon was replaced during the outage.
            // Reject the reconnect queue (stale calls must not reach a new
            // agent) and emit "held-then-expired" so the manager can expire
            // held PTY sessions. The channel itself stays alive — callers can
            // continue making fresh calls to the new agent.
            const previousEpoch = lastAgentEpoch;
            lastAgentEpoch = newEpoch;
            getChannelLogger().warn(
              `[${label}] daemon replaced during outage (epoch ${previousEpoch} -> ${newEpoch}); rejecting reconnect queue`,
            );
            rejectQueuedCalls(createAgentReconnectError("agent.reconnect-unavailable"));
            emitLifecycle({ type: "held-then-expired", previousEpoch, newEpoch });
            return;
          }
          // Epoch match: the daemon survived the outage.
          // Flush the reconnect queue and emit "ready" so PTY-aware consumers
          // (agent-host) can restore held sessions via session.list + pty.replay.
          lastAgentEpoch = newEpoch;
          flushQueuedCalls();
          emitLifecycle({ type: "ready" });
          return;
        }
        lastAgentEpoch = newEpoch;
        flushQueuedCalls();
        if (phase === "reconnecting") {
          // No-epoch reconnect (local agent / legacy remote): the replacement
          // agent completed its handshake but the epoch branch above did not
          // run, so without this emit the recovery is silent. Stateful
          // consumers need the `ready` signal to re-establish agent-side
          // registrations (fs.watch / git.watch replay) — a fresh agent
          // process starts with zero watches and nothing else re-issues them.
          emitLifecycle({ type: "ready" });
        }
      })
      .catch((error) => {
        if (state === "disposed" || active !== attempt) return;
        getChannelLogger().warn(
          `[${label}] agent handshake failed (phase=${phase}, pid=${attempt.child.pid}): ${error instanceof Error ? error.message : String(error)}`,
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

  /** Handles a pipe-classified fatal error such as bad protocol or auth stderr. */
  function handlePipeFailure(
    attempt: ActiveProcess,
    error: SshError,
    phase: "connecting" | "reconnecting",
  ): void {
    if (state === "disposed" || active !== attempt) return;
    getChannelLogger().warn(
      `[${label}] agent pipe failure (phase=${phase}, pid=${attempt.child.pid}, code=${error.code}): ${error.message}`,
    );
    if (phase === "reconnecting") {
      terminateChild(attempt);
      if (options.isFatalReconnectError?.(error)) {
        consecutiveFatalFailures += 1;
        if (consecutiveFatalFailures >= MAX_CONSECUTIVE_FATAL_RECONNECT_FAILURES) {
          escalateReconnectFailure(error);
          return;
        }
      } else {
        // A non-fatal failure between fatal ones means the environment is
        // still changing — restart the consecutive count.
        consecutiveFatalFailures = 0;
      }
      scheduleReconnect();
      return;
    }
    state = "terminal";
    terminalError = error;
    emitLifecycle({ type: "failure", error });
    terminateChild(attempt);
  }

  /**
   * Gives up on the reconnect loop after repeated deterministic failures.
   * Queued calls are rejected with the same error so callers see the real
   * cause (e.g. ssh.auth-failed) instead of a queue timeout.
   */
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

  /** Handles process spawn errors; reconnect attempts are retried silently. */
  function handleSpawnError(
    attempt: ActiveProcess,
    error: unknown,
    phase: "connecting" | "reconnecting",
  ): void {
    if (state === "disposed" || active !== attempt) return;
    getChannelLogger().warn(
      `[${label}] agent spawn error (phase=${phase}, pid=${attempt.child.pid}): ${error instanceof Error ? error.message : String(error)}`,
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

  /** Handles process close, reconnecting only for non-clean post-ready exits. */
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
    const tail = stderrTail.trim().slice(0, CLOSE_LOG_STDERR_TAIL_CHARS);
    getChannelLogger().warn(
      `[${label}] agent child closed (phase=${phase}, pid=${attempt.child.pid}, code=${code}, signal=${signal}, wasReady=${wasReady}, state=${state})${tail ? ` stderr=${tail}` : ""}`,
    );

    if (state === "disposed" || terminalError) return;
    if (code === 0 && wasReady) {
      getChannelLogger().info(`[${label}] clean agent exit; channel is now terminal`);
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
      // Notify session-style consumers (e.g. PTY) only on the ready→reconnecting
      // transition. Repeated retry attempts must not re-fire the event.
      if (!wasAlreadyReconnecting) {
        emitLifecycle({
          type: "reconnecting",
          cause: code === null ? null : new Error(`agent process exited with code ${code}`),
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

  /** Adds one reconnect-window call to the bounded queue. */
  function enqueueCall<TResult>(method: string, params: unknown): Promise<TResult> {
    if (queue.length >= reconnect.maxPendingCalls) {
      return Promise.reject(createAgentReconnectError("agent.reconnect-queue-overflow"));
    }

    return new Promise<TResult>((resolve, reject) => {
      const queued: QueuedCall = {
        method,
        params,
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

  /** Replays queued calls through the active ready pipe. */
  function flushQueuedCalls(): void {
    const pipe = active?.pipe;
    if (!pipe) return;
    for (const call of queue.splice(0)) {
      clearTimeout(call.timer);
      pipe.call(call.method, call.params).then(call.resolve, call.reject);
    }
  }

  /** Rejects every queued call and clears its timeout. */
  function rejectQueuedCalls(error: Error): void {
    for (const call of queue.splice(0)) {
      clearTimeout(call.timer);
      call.reject(error);
    }
  }

  /** Removes a timed-out call without disturbing the rest of the queue. */
  function removeQueuedCall(call: QueuedCall): void {
    const index = queue.indexOf(call);
    if (index >= 0) queue.splice(index, 1);
  }

  /** Schedules the next reconnect attempt with capped exponential backoff. */
  function scheduleReconnect(): void {
    if (state === "disposed" || terminalError || reconnectTimer) return;
    getChannelLogger().info(`[${label}] scheduling agent respawn in ${nextReconnectDelayMs}ms`);
    state = "reconnecting";
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (state === "disposed") return;
      try {
        spawnAttempt("reconnecting");
      } catch {
        // spawnAttempt already scheduled the next retry for reconnect phases.
      }
    }, nextReconnectDelayMs);
    reconnectTimer.unref?.();
    nextReconnectDelayMs = Math.min(nextReconnectDelayMs * 2, reconnect.maxDelayMs);
  }

  /**
   * Re-attaches every live event subscription to one fresh pipe. The
   * previous pipe (if any) has been disposed by the caller, so its
   * listener Set has been cleared — the registry's old upstream-dispose
   * handles are dead and safely overwritten by `rebind`.
   */
  function attachAllEvents(pipe: NdjsonPipe): void {
    events.rebind((event) => attachPipeEvent(pipe, event));
  }

  /**
   * Routes one pipe event into the registry's fan-out. Returns the
   * pipe-side unsubscribe so the registry can release the wrapper when the
   * last consumer goes away. Returns null only when there is no active
   * pipe yet — the next `attachAllEvents` will install one.
   */
  function attachPipeEvent(pipe: NdjsonPipe | null, event: string): (() => void) | null {
    if (!pipe) return null;
    return pipe.on(event, (payload) => events.emit(event, payload));
  }

  /** Sends SIGTERM now and schedules the 100ms SIGKILL fallback. */
  function terminateChild(attempt: ActiveProcess): void {
    if (attempt.closed || attempt.child.killed) return;
    attempt.child.kill("SIGTERM");
    scheduleForceKill(attempt);
  }

  /** Starts the hard-kill timer used when the child ignores disposal. */
  function scheduleForceKill(attempt: ActiveProcess): void {
    if (attempt.forceKillTimer) return;
    attempt.forceKillTimer = setTimeout(() => {
      attempt.child.kill("SIGKILL");
    }, DISPOSE_KILL_GRACE_MS);
    attempt.forceKillTimer.unref?.();
  }

  /** Clears the hard-kill timer after the child exits. */
  function clearForceKillTimer(attempt: ActiveProcess): void {
    if (!attempt.forceKillTimer) return;
    clearTimeout(attempt.forceKillTimer);
    attempt.forceKillTimer = null;
  }

  /** Cancels any pending reconnect timer. */
  function clearReconnectTimer(): void {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /** Delivers one lifecycle event to currently subscribed callbacks. */
  function emitLifecycle(event: ChannelLifecycleEvent): void {
    for (const callback of Array.from(lifecycleListeners)) callback(event);
  }
}

/** Normalizes reconnect queue/backoff knobs while preserving production defaults. */
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

/** Builds retryable errors for reconnect queue and transient process gaps. */
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

/** Creates the local disposal error used for abandoned reconnect waiters. */
function createDisposedErrorForChannel(): Error {
  const error = new Error("SSH channel disposed");
  error.name = "AbortError";
  return error;
}

/** Maps reconnect error codes to caller-facing messages. */
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
