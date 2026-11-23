import { create } from "zustand";
import type { AgentProfile } from "../../../shared/agent-profiles/profiles";
import { type AgentProfileStatus, isPersonalOrgName } from "../../../shared/agent-profiles/status";
import { ipcCallResult } from "../../ipc/client";

interface Entry {
  status?: AgentProfileStatus;
  loading: boolean;
}

interface ProfileStatusState {
  byId: Record<string, Entry>;
  refresh(profileId: string): Promise<AgentProfileStatus | undefined>;
}

export const useProfileStatusStore = create<ProfileStatusState>((set, get) => ({
  byId: {},
  async refresh(profileId) {
    set((s) => ({ byId: { ...s.byId, [profileId]: { ...s.byId[profileId], loading: true } } }));
    const result = await ipcCallResult("agentProfiles", "status", { profileId });
    const status: AgentProfileStatus = result.ok
      ? result.value
      : { state: "unavailable", message: result.message };
    set((s) => ({ byId: { ...s.byId, [profileId]: { status, loading: false } } }));
    return get().byId[profileId]?.status;
  },
}));

const PLAN_NAMES: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  plus: "Plus",
  free: "Free",
  business: "Business",
  edu: "Edu",
};

function planName(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  return PLAN_NAMES[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

export function statusSummary(
  agent: AgentProfile["agent"],
  status: Extract<AgentProfileStatus, { state: "signed-in" }>,
  words: { personal: string; apiKey: string; signedIn: string },
): { text: string; title: string } {
  const plan = planName(status.plan);
  if (status.method === "apikey" || status.method === "console") {
    return { text: words.apiKey, title: status.email ?? "" };
  }
  if (agent === "claude") {
    const personal = isPersonalOrgName(status.orgName, status.email);
    const org = personal ? words.personal : status.orgName;
    const text = [org, plan].filter(Boolean).join(" · ") || status.email || words.signedIn;
    const title = [status.email, personal ? status.orgName : undefined].filter(Boolean).join("\n");
    return { text, title };
  }
  const text = [status.email, plan].filter(Boolean).join(" · ") || words.signedIn;
  return { text, title: status.email ?? "" };
}
