import type { ChatPanel } from "../../../../packages/remote-protocol/src/view";
import type { UsageLine, UsageMeter, UsageMeterKind } from "../../services/chat/usage-line";

/** The plan's meters this app names; a kind a newer device sends is left out. */
const METER_KINDS: ReadonlySet<string> = new Set<UsageMeterKind>([
  "session",
  "weekly",
  "weekly_scoped",
  "window",
]);

/**
 * The line under the composer, as a chat's own: how full its context is, and
 * the plan's usage the device tells (planLimits), but for a window already
 * started over since it told.
 */
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
    // The week's for one model is told on hover, as a chat's own line tells it.
    meters: limits.filter((m) => m.kind !== "weekly_scoped"),
    more: limits.filter((m) => m.kind === "weekly_scoped"),
  };
}
