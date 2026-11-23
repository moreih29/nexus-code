import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import type { RateLimitInfo } from "../../services/chat/model";
import type { UsageLine, UsageMeter, UsageMeterKind } from "../../services/chat/usage-line";

const METER_KINDS: ReadonlySet<string> = new Set<UsageMeterKind>([
  "session",
  "weekly",
  "weekly_scoped",
  "window",
]);

export function usageLineOf(panel: ChatPanel | undefined, now = Date.now()): UsageLine | null {
  const context = panel?.context;
  const limits = (panel?.planLimits ?? []).filter(
    (m) => METER_KINDS.has(m.kind) && (m.resetsAt === undefined || m.resetsAt > now),
  ) as UsageMeter[];
  if (!context && limits.length === 0) return null;
  return {
    ...(context
      ? {
          context: {
            percent: Math.round((context.usedTokens / context.maxTokens) * 100),
            used: context.usedTokens,
            max: context.maxTokens,
          },
        }
      : {}),
    meters: limits.filter((m) => m.kind !== "weekly_scoped"),
    more: limits.filter((m) => m.kind === "weekly_scoped"),
  };
}

export function rateLimitOf(
  panel: ChatPanel | undefined,
  now = Date.now(),
): RateLimitInfo | undefined {
  const told = panel?.rateLimit;
  if (told) {
    if (told.resetsAt !== undefined && told.resetsAt <= now) return undefined;
    return {
      status: told.status,
      ...(told.kind ? { rateLimitType: told.kind } : {}),
      ...(told.resetsAt !== undefined ? { resetsAt: Math.floor(told.resetsAt / 1000) } : {}),
    };
  }
  const full = (panel?.planLimits ?? []).find(
    (m) => m.percent >= 100 && (m.resetsAt === undefined || m.resetsAt > now),
  );
  if (!full) return undefined;
  return {
    status: "rejected",
    rateLimitType: full.kind,
    ...(full.resetsAt !== undefined ? { resetsAt: Math.floor(full.resetsAt / 1000) } : {}),
  };
}
