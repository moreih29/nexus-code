/**
 * Git stderr progress receiver.
 *
 * Git writes clone progress to stderr using carriage-return updates. This
 * module maps the stable progress families to renderer phases and throttles
 * progress events to at most 20 per second so a fast remote cannot saturate
 * IPC with every terminal repaint.
 */
import type {
  GitClonePhase,
  GitClonePhaseEvent,
  GitCloneProgressEvent,
  GitCloneStreamProgressEvent,
} from "../../shared/types/git";

export const GIT_CLONE_PROGRESS_MIN_INTERVAL_MS = 50;

interface CloneProgressMatch {
  readonly phase: GitClonePhase;
  readonly pct: number;
  readonly received?: number;
  readonly total?: number;
}

interface GitStderrProgressReceiverOptions {
  readonly now?: () => number;
  readonly minIntervalMs?: number;
}

const PROGRESS_PATTERNS: Array<{
  readonly phase: GitClonePhase;
  readonly pattern: RegExp;
}> = [
  {
    phase: "counting",
    pattern: /(?:remote:\s*)?Counting objects:\s*(\d+)%\s*\((\d+)\/(\d+)\)/i,
  },
  {
    phase: "compressing",
    pattern: /(?:remote:\s*)?Compressing objects:\s*(\d+)%\s*\((\d+)\/(\d+)\)/i,
  },
  {
    phase: "receiving",
    pattern: /Receiving objects:\s*(\d+)%\s*\((\d+)\/(\d+)\)/i,
  },
  {
    phase: "resolving",
    pattern: /Resolving deltas:\s*(\d+)%\s*\((\d+)\/(\d+)\)/i,
  },
  {
    phase: "checkout",
    pattern: /(?:Updating files|Checking out files):\s*(\d+)%\s*\((\d+)\/(\d+)\)/i,
  },
];

/**
 * Stateful receiver that emits phase transitions immediately and progress
 * samples from Git stderr at the configured throttle interval.
 */
export class GitStderrProgressReceiver {
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private lastPhase: GitClonePhase | null = null;
  private lastProgressAt = Number.NEGATIVE_INFINITY;

  constructor(options: GitStderrProgressReceiverOptions = {}) {
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? GIT_CLONE_PROGRESS_MIN_INTERVAL_MS;
  }

  /**
   * Parses one terminal progress repaint line and returns zero or more
   * renderer events. New phases are never throttled; progress payloads are.
   */
  parseLine(line: string): GitCloneStreamProgressEvent[] {
    const match = parseCloneProgressLine(line);
    if (!match) return [];

    const events: GitCloneStreamProgressEvent[] = [];
    if (match.phase !== this.lastPhase) {
      this.lastPhase = match.phase;
      events.push({ kind: "phase", phase: match.phase } satisfies GitClonePhaseEvent);
    }

    if (this.shouldEmitProgress()) {
      this.lastProgressAt = this.now();
      events.push({
        kind: "progress",
        phase: match.phase,
        pct: match.pct,
        ...(match.received !== undefined ? { received: match.received } : {}),
        ...(match.total !== undefined ? { total: match.total } : {}),
      } satisfies GitCloneProgressEvent);
    }

    return events;
  }

  /**
   * Applies the 20/sec throttle to every progress payload.
   */
  private shouldEmitProgress(): boolean {
    return this.now() - this.lastProgressAt >= this.minIntervalMs;
  }
}

/**
 * Maps one Git stderr progress line to a normalized phase/pct/count tuple.
 */
export function parseCloneProgressLine(line: string): CloneProgressMatch | null {
  for (const { phase, pattern } of PROGRESS_PATTERNS) {
    const match = pattern.exec(line);
    if (!match) continue;
    const pct = clampPercent(Number.parseInt(match[1] ?? "0", 10));
    const received = Number.parseInt(match[2] ?? "0", 10);
    const total = Number.parseInt(match[3] ?? "0", 10);
    return {
      phase,
      pct,
      received: Number.isFinite(received) ? received : undefined,
      total: Number.isFinite(total) ? total : undefined,
    };
  }
  return null;
}

/**
 * Keeps malformed Git percentages inside the renderer schema's safe range.
 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}
