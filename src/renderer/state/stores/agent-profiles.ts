import { create } from "zustand";
import {
  type AgentProfile,
  type AgentProfiles,
  DEFAULT_PROFILE_DIR,
  EMPTY_AGENT_PROFILES,
  type MatchOptions,
  type ProfileTarget,
  type ProfileWorkspace,
  portableProfileDir,
  type ResolvedProfile,
  resolveProfile,
  ruleOfTarget,
  withoutProfile,
  withProfile,
  withRuleProfile,
} from "../../../shared/agent-profiles/profiles";
import { createLogger } from "../../../shared/log/renderer";
import type { ChatAgent } from "../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../shared/types/workspace";
import { ipcCallResult } from "../../ipc/client";
import { isWindows } from "../../utils/platform";

const log = createLogger("agent-profiles");

interface AgentProfilesState {
  config: AgentProfiles;
  home: string;
  defaultDirs: Record<ChatAgent, string>;
  hydrate(config: AgentProfiles | undefined): void;
  setHome(home: string, defaultDirs: Record<ChatAgent, string>): void;
  save(config: AgentProfiles): Promise<void>;
  saveProfile(profile: AgentProfile): Promise<void>;
  removeProfile(id: string): void;
  setDefault(agent: ChatAgent, profileId: string | null): void;
  setRule(target: ProfileTarget, agent: ChatAgent, profileId: string | null): void;
  removeRule(ruleId: string): void;
  addRule(target: ProfileTarget): void;
  setRuleKeep(target: ProfileTarget, agent: ChatAgent, profileId: string | null): void;
}

function newId(): string {
  return crypto.randomUUID();
}

export const useAgentProfilesStore = create<AgentProfilesState>((set, get) => ({
  config: EMPTY_AGENT_PROFILES,
  home: "",
  defaultDirs: { claude: "", codex: "" },
  hydrate(config) {
    set({ config: config ?? EMPTY_AGENT_PROFILES });
  },
  setHome(home, defaultDirs) {
    set({ home, defaultDirs });
  },
  async save(config) {
    set({ config });
    const result = await ipcCallResult("appState", "set", { agentProfiles: config });
    if (!result.ok) log.warn(`appState set (agentProfiles) failed: ${result.message}`);
  },
  saveProfile(profile) {
    return get().save(withProfile(get().config, profile));
  },
  removeProfile(id) {
    void get().save(withoutProfile(get().config, id));
  },
  setDefault(agent, profileId) {
    const defaults = { ...get().config.defaults };
    if (profileId === null) delete defaults[agent];
    else defaults[agent] = profileId;
    void get().save({ ...get().config, defaults });
  },
  setRule(target, agent, profileId) {
    void get().save(withRuleProfile(get().config, target, agent, profileId, newId, matchOptions()));
  },
  addRule(target) {
    const { config } = get();
    if (ruleOfTarget(config, target, matchOptions())) return;
    void get().save({ ...config, rules: [...config.rules, { id: newId(), target }] });
  },
  setRuleKeep(target, agent, profileId) {
    void get().save(
      withRuleProfile(get().config, target, agent, profileId, newId, matchOptions(), true),
    );
  },
  removeRule(ruleId) {
    const { config } = get();
    void get().save({ ...config, rules: config.rules.filter((r) => r.id !== ruleId) });
  },
}));

export function matchOptions(): MatchOptions {
  const { home } = useAgentProfilesStore.getState();
  return { windows: isWindows(), ...(home ? { home } : {}) };
}

export function profileWorkspace(
  workspace: Pick<WorkspaceMeta, "id" | "location" | "task">,
  all: readonly Pick<WorkspaceMeta, "id" | "location">[],
): ProfileWorkspace {
  const parentId = workspace.task?.parentId;
  const parent = parentId ? all.find((w) => w.id === parentId) : undefined;
  return {
    id: workspace.id,
    location: workspace.location,
    ...(parent ? { parent: { id: parent.id, location: parent.location } } : {}),
  };
}

export function resolveWorkspaceProfile(
  agent: ChatAgent,
  workspace: Pick<WorkspaceMeta, "id" | "location" | "task">,
  all: readonly Pick<WorkspaceMeta, "id" | "location">[],
  config: AgentProfiles = useAgentProfilesStore.getState().config,
): ResolvedProfile {
  return resolveProfile(config, agent, profileWorkspace(workspace, all), matchOptions());
}

export function tildePath(path: string, home = useAgentProfilesStore.getState().home): string {
  if (!home) return path;
  const sep = isWindows() ? /[\\/]/ : /\//;
  if (path === home) return "~";
  if (path.startsWith(home) && sep.test(path.charAt(home.length))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export function defaultFolderLabel(
  agent: ChatAgent,
  state: Pick<AgentProfilesState, "home" | "defaultDirs"> = useAgentProfilesStore.getState(),
): string {
  const dir = state.defaultDirs[agent];
  return dir ? portableProfileDir(tildePath(dir, state.home)) : DEFAULT_PROFILE_DIR[agent];
}

export async function loadProfilesHome(): Promise<void> {
  const result = await ipcCallResult("agentProfiles", "home", undefined);
  if (result.ok) {
    useAgentProfilesStore.getState().setHome(result.value.home, result.value.defaultDirs);
  }
}
