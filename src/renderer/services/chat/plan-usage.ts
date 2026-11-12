/**
 * The plan's usage, once per profile: one store every tab of a profile, the
 * agent list and the side panel read, filled by one request at a time.
 *
 * Before, each Claude and Codex tab asked for its own and kept what it heard:
 * tabs of one profile told different numbers, and several asking at once
 * met Anthropic's rate limit, whose answers (limits left out) wiped a tab's
 * meters. Now:
 *
 *   - A profile is its agent, the host its program runs on (a profile's
 *     folder is resolved there), and its id.
 *   - Tabs register as sources; an ask goes through one that can make it,
 *     an idle one before a busy one, hidden or not. Asks while one is out
 *     share it.
 *   - Every minute, while the window is shown, each profile one of whose
 *     tabs can ask is asked: its tabs show its usage as it goes, whether or
 *     not they have a turn (an empty one too), and once shown again the
 *     window asks at once. A tab asks too as it is shown or its program
 *     comes up, and after each turn.
 *   - After an answer, none for 50 seconds (Claude Code keeps its own
 *     snapshot for a minute); after a failure, 2, 4, 8, then 15 minutes, and
 *     the last good numbers stay. A profile without plan limits (an API key)
 *     is asked again after half an hour.
 *   - Codex's pushes (`account/rateLimits/updated`, after a turn) are taken
 *     in for every tab of the profile, and count as an answer.
 *   - An answer that shows what the store has (the same limits, resets to
 *     the minute) leaves it as it was, so nothing that shows it is drawn
 *     again.
 */

import { create } from "zustand";
import { defaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceLocation } from "../../../shared/types/workspace";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { type CodexRateLimits, mergeRateLimits, rateLimitsOf } from "./codex-model";
import { usageLimitsOf } from "./panel";

/** Every profile one of whose tabs can ask is asked this often, the window shown. */
export const POLL_MS = 60_000;
/** No ask for this long after an answer: a little less than POLL_MS, so each tick asks. */
export const FRESH_MS = 50_000;
/** An ask the user made (the side panel opened) waits this long since the last. */
export const FORCED_GAP_MS = 30_000;
/** A profile without plan limits is asked again after this. */
export const UNAVAILABLE_MS = 30 * 60_000;
/** After failures in a row: 2, 4, 8 minutes, then 15. */
const BACKOFF_MS = [2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];

export interface PlanUsage {
  /** Claude: get_usage's answer, as the usage line and side panel read it. */
  claude?: Record<string, unknown>;
  /** Codex: the windows of the profile's bucket. */
  codex?: CodexRateLimits;
  /** When the numbers were heard. */
  fetchedAt?: number;
  /** The profile has no plan limits (signed in with an API key). */
  unavailable?: boolean;
  failures: number;
  /** No ask before this, unless the user asks. */
  nextAt: number;
  lastAttemptAt: number;
}

/** A tab that can ask its program for the plan's usage. */
export interface PlanUsageSource {
  readonly agent: ChatAgent;
  /** The profile it asks for; a getter, as a tab can take up another profile's session. */
  usageKey(): string;
  /** Whether its program can be asked now. */
  ready(): boolean;
  /** Whether its program is in a turn: an idle one is asked first. */
  busy(): boolean;
  /** Asks, and gives back the answer as it came. */
  fetchUsage(): Promise<unknown>;
}

interface PlanUsageState {
  byKey: Record<string, PlanUsage>;
}

export const usePlanUsageStore = create<PlanUsageState>(() => ({ byKey: {} }));

const sources = new Set<PlanUsageSource>();
const inflight = new Map<string, Promise<void>>();
let clock: () => number = () => Date.now();
/** Stops the minute's asks; set while any tab is a source. */
let stopPoll: (() => void) | null = null;

/** The profile's key: its agent, the host its program runs on, its id. */
export function planUsageKey(
  agent: ChatAgent,
  location: WorkspaceLocation | undefined,
  profileId: string | undefined,
): string {
  return `${agent}|${hostKey(location)}|${profileId ?? defaultProfileId(agent)}`;
}

function hostKey(location: WorkspaceLocation | undefined): string {
  if (!location || location.kind === "local") return "local";
  if (location.kind === "wsl") return `wsl:${location.distro}`;
  return `ssh:${location.user ?? ""}@${location.host}:${location.port ?? 22}`;
}

/** The key of a tab of `workspaceId`'s, from the workspaces store as it is now. */
export function planUsageKeyFor(
  agent: ChatAgent,
  workspaceId: string,
  profileId: string | undefined,
): string {
  const location = useWorkspacesStore
    .getState()
    .workspaces.find((w) => w.id === workspaceId)?.location;
  return planUsageKey(agent, location, profileId);
}

/**
 * Adds a tab as a source; the function it gives back takes it away. The
 * minute's asks run while there is one.
 */
export function registerPlanSource(source: PlanUsageSource): () => void {
  sources.add(source);
  startPoll();
  return () => {
    sources.delete(source);
    if (sources.size === 0) endPoll();
  };
}

const windowShown = (): boolean =>
  typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Asks for each profile one of whose tabs can ask, if it is time; none
 * while the window is hidden.
 */
export function pollPlanUsage(): void {
  if (!windowShown()) return;
  const keys = new Set<string>();
  for (const source of sources) if (source.ready()) keys.add(source.usageKey());
  for (const key of keys) void wantPlanUsage(key);
}

function startPoll(): void {
  if (stopPoll) return;
  const timer = setInterval(pollPlanUsage, POLL_MS);
  // Shown again: what went by while it was hidden is asked at once.
  const onShown = () => {
    if (windowShown()) pollPlanUsage();
  };
  const page = typeof document === "undefined" ? undefined : document;
  page?.addEventListener?.("visibilitychange", onShown);
  stopPoll = () => {
    clearInterval(timer);
    page?.removeEventListener?.("visibilitychange", onShown);
  };
}

function endPoll(): void {
  stopPoll?.();
  stopPoll = null;
}

const empty = (): PlanUsage => ({ failures: 0, nextAt: 0, lastAttemptAt: 0 });

function entryOf(key: string): PlanUsage {
  return usePlanUsageStore.getState().byKey[key] ?? empty();
}

function patch(key: string, change: (entry: PlanUsage) => PlanUsage): void {
  usePlanUsageStore.setState((state) => ({
    byKey: { ...state.byKey, [key]: change(state.byKey[key] ?? empty()) },
  }));
}

/** Whether an ask may go out now: none while one is out, and none too soon. */
export function mayAsk(entry: PlanUsage, now: number, force: boolean): boolean {
  if (now >= entry.nextAt) return true;
  // The user's ask goes past the wait after an answer, not past a failure's.
  return force && entry.failures === 0 && now - entry.lastAttemptAt >= FORCED_GAP_MS;
}

/** How long to wait after `failures` failures in a row, give or take a tenth. */
export function backoffMs(failures: number, jitter: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
  return Math.round(base * (0.9 + 0.2 * jitter));
}

/**
 * Asks for the profile's usage, if it is time: through one of its tabs that
 * can, an idle one first. Asks while one is out wait for it.
 */
export function wantPlanUsage(
  key: string,
  { force = false }: { force?: boolean } = {},
): Promise<void> {
  const out = inflight.get(key);
  if (out) return out;
  const now = clock();
  if (!mayAsk(entryOf(key), now, force)) return Promise.resolve();
  const source = pickSource(key);
  // No tab can ask: it is no failure, and the next one that can will.
  if (!source) return Promise.resolve();
  patch(key, (entry) => ({ ...entry, lastAttemptAt: now }));
  const ask = source
    .fetchUsage()
    .then(
      (answer) => takeAnswer(key, source.agent, answer, clock()),
      (err: unknown) => {
        // The tab closed, or its program stopped, while it asked: no failure
        // of the profile's, and the next tab that can asks at once.
        if (!sources.has(source) || !source.ready()) {
          patch(key, (entry) => ({ ...entry, lastAttemptAt: 0 }));
        } else if (source.agent === "codex" && isNoChatGpt(err)) {
          takeUnavailable(key, clock());
        } else {
          takeFailure(key, clock());
        }
      },
    )
    .finally(() => inflight.delete(key));
  inflight.set(key, ask);
  return ask;
}

function pickSource(key: string): PlanUsageSource | undefined {
  let busy: PlanUsageSource | undefined;
  for (const source of sources) {
    if (source.usageKey() !== key || !source.ready()) continue;
    if (!source.busy()) return source;
    busy ??= source;
  }
  return busy;
}

function takeAnswer(key: string, agent: ChatAgent, answer: unknown, at: number): void {
  if (agent === "claude") {
    const body = answer as Record<string, unknown>;
    if (usageLimitsOf(body).length > 0) {
      ingestClaudeUsage(key, body, at);
      return;
    }
    // An API key's profile has no plan limits to tell.
    if (body?.rate_limits_available === false) {
      takeUnavailable(key, at);
      return;
    }
    // The usage endpoint failed (a 429 among them), and Claude Code answered
    // with no limits: a failure, whose last good numbers stay.
    takeFailure(key, at);
    return;
  }
  const limits = rateLimitsOf((answer as Record<string, unknown>)?.rateLimits);
  if (limits) ingestCodexLimits(key, limits, at);
  else takeFailure(key, at);
}

/** Codex without a ChatGPT sign-in errs ("chatgpt authentication required"): it has no limits, which is no failure. */
function isNoChatGpt(err: unknown): boolean {
  return err instanceof Error && /chatgpt/i.test(err.message);
}

function takeFailure(key: string, at: number): void {
  patch(key, (entry) => {
    const failures = entry.failures + 1;
    return { ...entry, failures, nextAt: at + backoffMs(failures) };
  });
}

function takeUnavailable(key: string, at: number): void {
  patch(key, (entry) => ({
    ...entry,
    unavailable: true,
    failures: 0,
    nextAt: at + UNAVAILABLE_MS,
  }));
}

/** `next`, or `kept` when it tells the same: an answer that changed nothing redraws nothing. */
function sameOr<T>(kept: T | undefined, next: T): T {
  return kept !== undefined && JSON.stringify(kept) === JSON.stringify(next) ? kept : next;
}

/**
 * What of a Claude answer is shown: its limits, each reset to the minute.
 * Each answer tells a reset to the microsecond, a little differently, and
 * how long the session ran, which nothing shows.
 */
function claudeShown(body: Record<string, unknown>): string {
  return JSON.stringify(
    usageLimitsOf(body).map((limit) => ({
      ...limit,
      resetsAt: limit.resetsAt ? Math.round(Date.parse(limit.resetsAt) / 60_000) : null,
    })),
  );
}

/** `body`, or `kept` when it shows the same. */
function sameClaude(
  kept: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return kept !== undefined && claudeShown(kept) === claudeShown(body) ? kept : body;
}

/** A Claude answer with the plan's limits. An older one than the store has is left out. */
export function ingestClaudeUsage(key: string, body: Record<string, unknown>, at: number): void {
  patch(key, (entry) =>
    entry.fetchedAt !== undefined && at < entry.fetchedAt
      ? entry
      : {
          ...entry,
          claude: sameClaude(entry.claude, body),
          fetchedAt: at,
          unavailable: false,
          failures: 0,
          nextAt: at + FRESH_MS,
        },
  );
}

/** Codex windows read whole. An older read than the store has is left out. */
export function ingestCodexLimits(key: string, limits: CodexRateLimits, at: number): void {
  patch(key, (entry) =>
    entry.fetchedAt !== undefined && at < entry.fetchedAt
      ? entry
      : {
          ...entry,
          codex: sameOr(entry.codex, limits),
          fetchedAt: at,
          unavailable: false,
          failures: 0,
          nextAt: at + FRESH_MS,
        },
  );
}

/** A Codex push, which may carry one window and is laid over what the store has. */
export function ingestCodexPush(key: string, raw: unknown, at: number): void {
  patch(key, (entry) => {
    const codex = mergeRateLimits(entry.codex, raw);
    if (!codex || codex === entry.codex) return entry;
    return {
      ...entry,
      codex,
      fetchedAt: at,
      unavailable: false,
      failures: 0,
      nextAt: at + FRESH_MS,
    };
  });
}

/** Asks may go out at once again: a new sign-in makes what was heard, or the wait, past. */
export function forgetPlanWait(key: string): void {
  patch(key, (entry) => ({ ...entry, failures: 0, nextAt: 0, unavailable: false }));
}

function usePlanKey(agent: ChatAgent, workspaceId: string, profileId: string | undefined): string {
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  return planUsageKey(agent, location, profileId);
}

/**
 * A Claude profile's usage for a tab of `workspaceId`'s, as the store has
 * it: the same object until an answer tells other numbers, so the asks
 * between draw nothing again.
 */
export function usePlanClaudeUsage(
  workspaceId: string,
  profileId: string | undefined,
): Record<string, unknown> | undefined {
  const key = usePlanKey("claude", workspaceId, profileId);
  return usePlanUsageStore((s) => s.byKey[key]?.claude);
}

/** A Codex profile's limits for a tab of `workspaceId`'s, as usePlanClaudeUsage. */
export function usePlanCodexLimits(
  workspaceId: string,
  profileId: string | undefined,
): CodexRateLimits | undefined {
  const key = usePlanKey("codex", workspaceId, profileId);
  return usePlanUsageStore((s) => s.byKey[key]?.codex);
}

/** For tests: forgets every profile, source and ask, stops the minute's asks, and reads the time from `now`. */
export function resetPlanUsage(now: () => number = () => Date.now()): void {
  endPoll();
  sources.clear();
  inflight.clear();
  clock = now;
  usePlanUsageStore.setState({ byKey: {} });
}
