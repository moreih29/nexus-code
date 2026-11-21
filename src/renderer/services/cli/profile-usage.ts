import type { ViewUsageMeter } from "../../../../packages/remote-protocol/src";
import {
  type AgentProfile,
  PROFILE_AGENTS,
  profilesOf,
} from "../../../shared/agent-profiles/profiles";
import type { CliUiOps } from "../../../shared/cli/ui";
import { useAgentProfilesStore } from "../../state/stores/agent-profiles";
import { useWorkspacesStore } from "../../state/stores/workspaces";
import { ChatController } from "../chat/claude/controller";
import { usageLimitsOf } from "../chat/claude/usage-limits";
import { CodexController } from "../chat/codex/controller";
import {
  type PlanUsage,
  POLL_MS,
  planUsageKey,
  usePlanUsageStore,
  wantPlanUsage,
} from "../chat/plan-usage";
import { codexMeter } from "../chat/usage-line";
import { cliProfileName } from "../remote/profile-name";
import { type CliUiHandler, UiRequestError } from "./handler";

type ProfileUsageRow = CliUiOps["chat.usage"]["result"]["profiles"][number];

function isSubscription(profile: AgentProfile): boolean {
  return !profile.connection || profile.connection.method === "account";
}

function selectProfile(profiles: readonly AgentProfile[], selector: string): AgentProfile {
  const exact = profiles.find(({ id }) => id === selector);
  if (exact) return exact;
  const wanted = selector.toLowerCase();
  const [profile, ...others] = profiles.filter(
    (p) => p.id.toLowerCase() === wanted || cliProfileName(p).toLowerCase() === wanted,
  );
  if (others.length > 0) {
    throw new UiRequestError(
      `more than one profile matches "${selector}". Use its id from nexus chat profiles.`,
    );
  }
  if (!profile) {
    throw new UiRequestError(`no profile "${selector}". See nexus chat profiles.`);
  }
  return profile;
}

function usageRow(
  profile: AgentProfile,
  plan: PlanUsage | undefined,
  now: number,
): ProfileUsageRow {
  const { id, agent } = profile;
  const row = { id, name: cliProfileName(profile), agent };
  if (!isSubscription(profile)) return { ...row, status: "not-subscription", limits: [] };
  const fetchedAt = plan?.fetchedAt;
  if (fetchedAt === undefined || plan?.unavailable) {
    return { ...row, status: "unavailable", limits: [] };
  }
  const observed = (meter: ViewUsageMeter, at: number) => ({
    ...meter,
    fetchedAt: at,
    stale: now - at >= 2 * POLL_MS || (meter.resetsAt !== undefined && meter.resetsAt <= now),
  });
  const limits =
    agent === "claude"
      ? usageLimitsOf(plan?.claude).map(({ kind, scope, percent, resetsAt }) => {
          const reset = Date.parse(resetsAt ?? "");
          return observed(
            {
              kind: kind === "weekly_all" ? "weekly" : kind,
              percent,
              ...(scope ? { scope } : {}),
              ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
            },
            fetchedAt,
          );
        })
      : (["primary", "secondary"] as const).flatMap((slot) => {
          const window = plan?.codex?.[slot];
          return window
            ? [observed(codexMeter(window), plan?.codexFetchedAt?.[slot] ?? fetchedAt)]
            : [];
        });
  if (limits.length === 0) return { ...row, status: "unavailable", limits };
  const status = limits.some((limit) => limit.stale) ? "stale" : "fresh";
  return { ...row, status, fetchedAt, limits };
}

export const profileUsage: CliUiHandler<"chat.usage"> = async ({
  agent,
  profile: selector,
  workspaceId,
  refresh,
}) => {
  const { config } = useAgentProfilesStore.getState();
  const { workspaces } = useWorkspacesStore.getState();
  const workspace =
    workspaceId === undefined
      ? workspaces.find((w) => w.location.kind === "local")
      : workspaces.find((w) => w.id === workspaceId);
  if (workspaceId !== undefined && !workspace) throw new UiRequestError("that workspace is gone");
  const profiles = (agent ? [agent] : PROFILE_AGENTS).flatMap((a) => profilesOf(config, a));
  const selected = selector === undefined ? profiles : [selectProfile(profiles, selector)];
  const rows = selected.map((profile) => ({
    profile,
    key: planUsageKey(profile.agent, workspace?.location, profile.id),
  }));
  if (refresh) {
    await Promise.all(
      rows
        .filter(({ profile }) => isSubscription(profile))
        .map(({ profile, key }) => {
          const probePlanUsage =
            profile.agent === "claude"
              ? ChatController.probePlanUsage
              : CodexController.probePlanUsage;
          return wantPlanUsage(key, {
            force: true,
            ...(workspace
              ? {
                  probe: {
                    agent: profile.agent,
                    fetchUsage: () =>
                      probePlanUsage({
                        workspaceId: workspace.id,
                        cwd: workspace.rootPath,
                        profileId: profile.id,
                      }),
                  },
                }
              : {}),
          });
        }),
    );
  }
  const { byKey } = usePlanUsageStore.getState();
  const now = Date.now();
  return { profiles: rows.map(({ profile, key }) => usageRow(profile, byKey[key], now)) };
};
