import { create } from "zustand";
import { defaultProfileId } from "../../../shared/agent-profiles/profiles";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceLocation } from "../../../shared/types/workspace";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { type CodexRateLimits, mergeRateLimits, rateLimitsOf } from "./codex/model";
import { usageLimitsOf } from "./panel";

export const POLL_MS = 60_000;
export const FRESH_MS = 50_000;
export const FORCED_GAP_MS = 30_000;
export const UNAVAILABLE_MS = 30 * 60_000;
const BACKOFF_MS = [2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];

export interface PlanUsage {
  claude?: Record<string, unknown>;
  codex?: CodexRateLimits;
  codexFetchedAt?: Partial<Record<"primary" | "secondary", number>>;
  fetchedAt?: number;
  unavailable?: boolean;
  failures: number;
  nextAt: number;
  lastAttemptAt: number;
}

export interface PlanUsageSource {
  readonly agent: ChatAgent;
  usageKey(): string;
  ready(): boolean;
  busy(): boolean;
  fetchUsage(): Promise<unknown>;
}

interface PlanUsageState {
  byKey: Record<string, PlanUsage>;
}

export const usePlanUsageStore = create<PlanUsageState>(() => ({ byKey: {} }));

const sources = new Set<PlanUsageSource>();
const watchedAfar = new Map<string, () => string | null>();
const inflight = new Map<string, Promise<void>>();
let clock: () => number = () => Date.now();
let stopPoll: (() => void) | null = null;

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

export function pollPlanUsage(): void {
  const shown = windowShown();
  const afar = new Set<string>();
  for (const keyOf of watchedAfar.values()) {
    const key = keyOf();
    if (key) afar.add(key);
  }
  const keys = new Set<string>();
  for (const source of sources) {
    if (!source.ready()) continue;
    const key = source.usageKey();
    if (shown || afar.has(key)) keys.add(key);
  }
  for (const key of keys) void wantPlanUsage(key);
}

export function watchPlanUsageAfar(watchId: string, keyOf: () => string | null): () => void {
  watchedAfar.set(watchId, keyOf);
  const key = keyOf();
  if (key) void wantPlanUsage(key);
  return () => {
    if (watchedAfar.get(watchId) === keyOf) watchedAfar.delete(watchId);
  };
}

function startPoll(): void {
  if (stopPoll) return;
  const timer = setInterval(pollPlanUsage, POLL_MS);
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

export function mayAsk(entry: PlanUsage, now: number, force: boolean): boolean {
  if (now >= entry.nextAt) return true;
  return force && entry.failures === 0 && now - entry.lastAttemptAt >= FORCED_GAP_MS;
}

export function backoffMs(failures: number, jitter: number = Math.random()): number {
  const base = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
  return Math.round(base * (0.9 + 0.2 * jitter));
}

export function wantPlanUsage(
  key: string,
  {
    force = false,
    probe,
  }: { force?: boolean; probe?: Pick<PlanUsageSource, "agent" | "fetchUsage"> } = {},
): Promise<void> {
  const out = inflight.get(key);
  if (out) return out;
  const now = clock();
  if (!mayAsk(entryOf(key), now, force)) return Promise.resolve();
  const source = pickSource(key);
  const requester = source ?? probe;
  if (!requester) return Promise.resolve();
  patch(key, (entry) => ({ ...entry, lastAttemptAt: now }));
  const ask = requester
    .fetchUsage()
    .then(
      (answer) => takeAnswer(key, requester.agent, answer, clock()),
      (err: unknown) => {
        if (source && (!sources.has(source) || !source.ready())) {
          patch(key, (entry) => ({ ...entry, lastAttemptAt: 0 }));
        } else if (requester.agent === "codex" && isNoChatGpt(err)) {
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
    if (body?.rate_limits_available === false) {
      takeUnavailable(key, at);
      return;
    }
    takeFailure(key, at);
    return;
  }
  const limits = rateLimitsOf((answer as Record<string, unknown>)?.rateLimits);
  if (limits) ingestCodexLimits(key, limits, at);
  else takeFailure(key, at);
}

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

function sameOr<T>(kept: T | undefined, next: T): T {
  return kept !== undefined && JSON.stringify(kept) === JSON.stringify(next) ? kept : next;
}

function claudeShown(body: Record<string, unknown>): string {
  return JSON.stringify(
    usageLimitsOf(body).map((limit) => ({
      ...limit,
      resetsAt: limit.resetsAt ? Math.round(Date.parse(limit.resetsAt) / 60_000) : null,
    })),
  );
}

function sameClaude(
  kept: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
): Record<string, unknown> {
  return kept !== undefined && claudeShown(kept) === claudeShown(body) ? kept : body;
}

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

export function ingestCodexLimits(key: string, limits: CodexRateLimits, at: number): void {
  patch(key, (entry) =>
    entry.fetchedAt !== undefined && at < entry.fetchedAt
      ? entry
      : {
          ...entry,
          codex: sameOr(entry.codex, limits),
          codexFetchedAt: {
            ...(limits.primary ? { primary: at } : {}),
            ...(limits.secondary ? { secondary: at } : {}),
          },
          fetchedAt: at,
          unavailable: false,
          failures: 0,
          nextAt: at + FRESH_MS,
        },
  );
}

export function ingestCodexPush(key: string, raw: unknown, at: number): void {
  patch(key, (entry) => {
    if (entry.fetchedAt !== undefined && at < entry.fetchedAt) return entry;
    const codex = mergeRateLimits(entry.codex, raw);
    if (!codex || codex === entry.codex) return entry;
    return {
      ...entry,
      codex: sameOr(entry.codex, codex),
      codexFetchedAt: {
        ...entry.codexFetchedAt,
        ...(codex.primary && codex.primary !== entry.codex?.primary ? { primary: at } : {}),
        ...(codex.secondary && codex.secondary !== entry.codex?.secondary ? { secondary: at } : {}),
      },
      fetchedAt: at,
      unavailable: false,
      failures: 0,
      nextAt: at + FRESH_MS,
    };
  });
}

export function forgetPlanWait(key: string): void {
  patch(key, (entry) => ({ ...entry, failures: 0, nextAt: 0, unavailable: false }));
}

function usePlanKey(agent: ChatAgent, workspaceId: string, profileId: string | undefined): string {
  const location = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.location,
  );
  return planUsageKey(agent, location, profileId);
}

export function usePlanClaudeUsage(
  workspaceId: string,
  profileId: string | undefined,
): Record<string, unknown> | undefined {
  const key = usePlanKey("claude", workspaceId, profileId);
  return usePlanUsageStore((s) => s.byKey[key]?.claude);
}

export function usePlanCodexLimits(
  workspaceId: string,
  profileId: string | undefined,
): CodexRateLimits | undefined {
  const key = usePlanKey("codex", workspaceId, profileId);
  return usePlanUsageStore((s) => s.byKey[key]?.codex);
}

export function resetPlanUsage(now: () => number = () => Date.now()): void {
  endPoll();
  sources.clear();
  watchedAfar.clear();
  inflight.clear();
  clock = now;
  usePlanUsageStore.setState({ byKey: {} });
}
