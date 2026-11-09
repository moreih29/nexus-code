// The Claude and Codex profiles and the rules that pick a workspace's
// (shared/agent-profiles). appState in main is the authoritative store; each
// window keeps a copy, and takes another window's edits as they are saved
// (appState.agentProfilesChanged).

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
  /** This machine's home folder, once main has told it; "" until then. */
  home: string;
  /** Each agent's default folder on this machine, once main has told it; "" until then. */
  defaultDirs: Record<ChatAgent, string>;
  hydrate(config: AgentProfiles | undefined): void;
  setHome(home: string, defaultDirs: Record<ChatAgent, string>): void;
  /** Saves a whole new config, as every edit below does; settles once main has it. */
  save(config: AgentProfiles): Promise<void>;
  saveProfile(profile: AgentProfile): Promise<void>;
  removeProfile(id: string): void;
  /** The agent's profile where no rule says; null = the default profile. */
  setDefault(agent: ChatAgent, profileId: string | null): void;
  /** The target's rule gives the agent the profile; null leaves it to the next rule. */
  setRule(target: ProfileTarget, agent: ChatAgent, profileId: string | null): void;
  removeRule(ruleId: string): void;
  /** Adds a rule for the target that sets no agent yet; none when it has one. */
  addRule(target: ProfileTarget): void;
  /** As setRule, keeping the rule when it is left setting no agent. */
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

/** How this machine's paths compare. */
export function matchOptions(): MatchOptions {
  const { home } = useAgentProfilesStore.getState();
  return { windows: isWindows(), ...(home ? { home } : {}) };
}

/** What the rules match a workspace by: itself, and the workspace its task was made from. */
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

/** The profile the agent runs with in the workspace, and why. */
export function resolveWorkspaceProfile(
  agent: ChatAgent,
  workspace: Pick<WorkspaceMeta, "id" | "location" | "task">,
  all: readonly Pick<WorkspaceMeta, "id" | "location">[],
  config: AgentProfiles = useAgentProfilesStore.getState().config,
): ResolvedProfile {
  return resolveProfile(config, agent, profileWorkspace(workspace, all), matchOptions());
}

/** "~/x" for a path in the home folder. */
export function tildePath(path: string, home = useAgentProfilesStore.getState().home): string {
  if (!home) return path;
  const sep = isWindows() ? /[\\/]/ : /\//;
  if (path === home) return "~";
  if (path.startsWith(home) && sep.test(path.charAt(home.length))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

/**
 * The folder the agent's default profile uses on this machine, as shown:
 * ~/.claude or ~/.codex, or the folder CLAUDE_CONFIG_DIR or CODEX_HOME names.
 */
export function defaultFolderLabel(
  agent: ChatAgent,
  state: Pick<AgentProfilesState, "home" | "defaultDirs"> = useAgentProfilesStore.getState(),
): string {
  const dir = state.defaultDirs[agent];
  return dir ? portableProfileDir(tildePath(dir, state.home)) : DEFAULT_PROFILE_DIR[agent];
}

/** Reads this machine's home folder, for "~/" paths, and the agents' default folders. */
export async function loadProfilesHome(): Promise<void> {
  const result = await ipcCallResult("agentProfiles", "home", undefined);
  if (result.ok) {
    useAgentProfilesStore.getState().setHome(result.value.home, result.value.defaultDirs);
  }
}
