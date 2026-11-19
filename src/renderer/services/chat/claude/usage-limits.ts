// The plan's limits in a get_usage answer, which Claude Code gives in one of
// two shapes: the usage endpoint's list (`rate_limits.limits`), or, when
// that endpoint failed (a 429 among them), the windows the API's last
// response headers told (`rate_limits.five_hour`, `rate_limits.seven_day`),
// with at most a model's own week in the list.

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface UsageLimit {
  kind: string;
  /** What a scoped limit covers: a model's name. */
  scope?: string;
  percent: number;
  resetsAt?: string;
  active: boolean;
}

/** The headers' windows, and the kind of limit each is in the list. */
const HEADER_WINDOWS = [
  ["five_hour", "session"],
  ["seven_day", "weekly_all"],
] as const;

/** get_usage's limits: the headers' windows, unless the list has them, then the list. */
export function usageLimitsOf(usage: unknown): UsageLimit[] {
  const rates = rec(rec(usage)?.rate_limits);
  const listed: UsageLimit[] = (Array.isArray(rates?.limits) ? rates.limits : []).flatMap((raw) => {
    const limit = rec(raw);
    const kind = str(limit?.kind);
    if (!limit || !kind || typeof limit.percent !== "number") return [];
    const scope = rec(rec(limit.scope)?.model);
    return [
      {
        kind,
        ...(str(scope?.display_name) ? { scope: str(scope?.display_name) } : {}),
        percent: limit.percent,
        resetsAt: str(limit.resets_at),
        active: limit.is_active === true,
      },
    ];
  });
  const told: UsageLimit[] = HEADER_WINDOWS.flatMap(([field, kind]) => {
    const window = rec(rates?.[field]);
    if (!window || typeof window.utilization !== "number") return [];
    if (listed.some((limit) => limit.kind === kind)) return [];
    return [{ kind, percent: window.utilization, resetsAt: str(window.resets_at), active: false }];
  });
  return [...told, ...listed];
}
