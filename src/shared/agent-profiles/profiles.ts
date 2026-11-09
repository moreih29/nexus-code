/**
 * Agent profiles: a Claude or Codex config folder (CLAUDE_CONFIG_DIR,
 * CODEX_HOME), each with its own sign-in, history and settings; and the
 * rules that pick a workspace's profile for each agent. Every agent has a
 * profile in its default folder, which sets no variable at all.
 */

import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";
import type { WorkspaceLocation } from "../types/workspace";

export const PROFILE_AGENTS = ["claude", "codex"] as const satisfies readonly ChatAgent[];

/** The colors a profile's dot may have; the renderer maps each to a token. */
export const PROFILE_COLORS = ["blue", "violet", "green", "amber", "rose", "cyan", "gray"] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];

/** The variable that points each agent at a profile's folder. */
export const PROFILE_DIR_ENV: Record<ChatAgent, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

/** The default folder each agent uses when its variable is unset. */
export const DEFAULT_PROFILE_DIR: Record<ChatAgent, string> = {
  claude: "~/.claude",
  codex: "~/.codex",
};

/**
 * What a profile's folder may link from the default folder, so the profiles
 * share it: instructions, settings, skills… Sign-ins and history stay apart.
 */
export const SHAREABLE: Record<ChatAgent, readonly string[]> = {
  claude: ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "plugins"],
  codex: ["AGENTS.md", "config.toml", "prompts", "skills", "rules"],
};

/** What a new profile links unless the user unticks it. */
export const SHARED_BY_DEFAULT: Record<ChatAgent, readonly string[]> = {
  claude: ["CLAUDE.md", "settings.json", "skills", "agents", "commands"],
  codex: ["AGENTS.md", "config.toml", "prompts", "skills"],
};

/** The id of an agent's profile in its default folder. */
export function defaultProfileId(agent: ChatAgent): string {
  return `${agent}-default`;
}

export function isDefaultProfileId(id: string): boolean {
  return id === defaultProfileId("claude") || id === defaultProfileId("codex");
}

const ProfileIdSchema = z.string().min(1).max(64);

const EnvKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const AgentProfileSchema = z.object({
  id: ProfileIdSchema,
  agent: z.enum(PROFILE_AGENTS),
  /** The user's name for it; "" on the default profile = its usual name. */
  name: z.string().max(40),
  /** A PROFILE_COLORS name, kept as a plain string for colors to come. */
  color: z.string().max(16),
  /** The config folder, "~/" for the home folder; "" = the default folder. */
  dir: z.string().max(1024),
  /** What the folder links from the default folder (SHAREABLE names). */
  shared: z.array(z.string().max(64)).max(32).optional(),
  /** More variables the agent runs with. */
  env: z.record(EnvKeySchema, z.string().max(4096)).optional(),
});
export type AgentProfile = z.infer<typeof AgentProfileSchema>;

export const ProfileTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().uuid() }),
  /** A local folder and every folder under it. */
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(1024) }),
  /** Every workspace on an SSH host, by the name it was reached by. */
  z.object({ kind: z.literal("ssh"), host: z.string().min(1).max(255) }),
]);
export type ProfileTarget = z.infer<typeof ProfileTargetSchema>;
export type ProfileTargetKind = ProfileTarget["kind"];

export const ProfileRuleSchema = z.object({
  id: z.string().min(1).max(64),
  target: ProfileTargetSchema,
  /** The profile each agent gets; absent = the next rule's, or the default. */
  claude: ProfileIdSchema.optional(),
  codex: ProfileIdSchema.optional(),
});
export type ProfileRule = z.infer<typeof ProfileRuleSchema>;

/** An array that drops the entries it cannot read, rather than failing whole. */
function lenientArray<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => item.safeParse(entry).success).slice(0, max)
        : value,
    z.array(item).max(max),
  );
}

export const AgentProfilesSchema = z.object({
  profiles: lenientArray(AgentProfileSchema, 64),
  rules: lenientArray(ProfileRuleSchema, 512),
  /** Each agent's profile where no rule says; absent = the default profile. */
  defaults: z.object({ claude: ProfileIdSchema.optional(), codex: ProfileIdSchema.optional() }),
});
export type AgentProfiles = z.infer<typeof AgentProfilesSchema>;

export const EMPTY_AGENT_PROFILES: AgentProfiles = { profiles: [], rules: [], defaults: {} };

const DEFAULT_COLORS: Record<ChatAgent, ProfileColor> = { claude: "blue", codex: "cyan" };

/** An agent's profiles, its default-folder one first. */
export function profilesOf(config: AgentProfiles, agent: ChatAgent): AgentProfile[] {
  const id = defaultProfileId(agent);
  const stored = config.profiles.find((p) => p.id === id);
  const first: AgentProfile = {
    id,
    agent,
    name: stored?.name ?? "",
    color: stored?.color ?? DEFAULT_COLORS[agent],
    dir: "",
    ...(stored?.env ? { env: stored.env } : {}),
  };
  return [first, ...config.profiles.filter((p) => p.agent === agent && p.id !== id)];
}

/** The agent's profile of that id; the default one for an id it has not. */
export function profileOf(
  config: AgentProfiles,
  agent: ChatAgent,
  id: string | undefined,
): AgentProfile {
  const all = profilesOf(config, agent);
  return all.find((p) => p.id === id) ?? (all[0] as AgentProfile);
}

/** Whether the agent has a profile of that id. */
export function hasProfile(config: AgentProfiles, agent: ChatAgent, id: string): boolean {
  return profilesOf(config, agent).some((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Which profile a workspace gets
// ---------------------------------------------------------------------------

/** What a rule matches a workspace by. */
export interface ProfileWorkspace {
  id: string;
  location: WorkspaceLocation;
  /** The workspace a task was made from: a task follows its rules too. */
  parent?: { id: string; location: WorkspaceLocation } | undefined;
}

export interface MatchOptions {
  /** Paths compare without case, and with either slash. */
  windows?: boolean;
  /** The home folder, for a folder rule written with "~". */
  home?: string;
}

/** Why a workspace has its profile: the rule that set it, or none. */
export type ProfileSource =
  | { kind: "workspace"; ruleId: string }
  | { kind: "folder"; ruleId: string }
  | { kind: "ssh"; ruleId: string }
  | { kind: "default" };

export interface ResolvedProfile {
  profile: AgentProfile;
  source: ProfileSource;
}

function normalizePath(path: string, options: MatchOptions): string {
  let p = path;
  if (options.home && (p === "~" || p.startsWith("~/") || p.startsWith("~\\"))) {
    p = options.home + p.slice(1);
  }
  if (options.windows) p = p.replace(/\\/g, "/").toLowerCase();
  p = p.replace(/\/+$/, "");
  return p === "" ? "/" : p;
}

/** How deep the folder is when `path` lies in it (0 = the root), else -1. */
export function folderDepth(folder: string, path: string, options: MatchOptions = {}): number {
  const dir = normalizePath(folder, options);
  const target = normalizePath(path, options);
  const inside =
    dir === "/" ? target.startsWith("/") : target === dir || target.startsWith(`${dir}/`);
  if (!inside) return -1;
  return dir.split("/").filter(Boolean).length;
}

function sshNames(location: WorkspaceLocation): string[] {
  if (location.kind !== "ssh") return [];
  return [location.configAlias, location.host]
    .filter((name): name is string => typeof name === "string" && name !== "")
    .map((name) => name.toLowerCase());
}

/** The workspace and the one its task was made from, its own first. */
function subjects(ws: ProfileWorkspace): { id: string; location: WorkspaceLocation }[] {
  return ws.parent ? [ws, ws.parent] : [ws];
}

/** Whether the rule's target takes in the workspace. */
export function ruleMatches(
  rule: ProfileRule,
  ws: ProfileWorkspace,
  options: MatchOptions = {},
): boolean {
  const { target } = rule;
  return subjects(ws).some((s) => {
    switch (target.kind) {
      case "workspace":
        return s.id === target.workspaceId;
      case "folder":
        return (
          s.location.kind === "local" && folderDepth(target.path, s.location.rootPath, options) >= 0
        );
      case "ssh":
        return sshNames(s.location).includes(target.host.toLowerCase());
      default:
        return false;
    }
  });
}

/**
 * The rule that sets the agent's profile for the workspace: one for the
 * workspace itself, then the deepest folder it is in, then its SSH host. A
 * rule that leaves the agent out, or names a profile gone, is passed over.
 */
export function ruleFor(
  config: AgentProfiles,
  agent: ChatAgent,
  ws: ProfileWorkspace,
  options: MatchOptions = {},
): ProfileRule | undefined {
  const usable = config.rules.filter((rule) => {
    const id = rule[agent];
    return id !== undefined && hasProfile(config, agent, id) && ruleMatches(rule, ws, options);
  });
  for (const s of subjects(ws)) {
    const own = usable.find((r) => r.target.kind === "workspace" && r.target.workspaceId === s.id);
    if (own) return own;
  }
  let deepest: { rule: ProfileRule; depth: number } | undefined;
  for (const rule of usable) {
    if (rule.target.kind !== "folder") continue;
    for (const s of subjects(ws)) {
      if (s.location.kind !== "local") continue;
      const depth = folderDepth(rule.target.path, s.location.rootPath, options);
      if (depth >= 0 && (!deepest || depth > deepest.depth)) deepest = { rule, depth };
    }
  }
  if (deepest) return deepest.rule;
  return usable.find((r) => r.target.kind === "ssh");
}

/** The profile the agent runs with in the workspace, and why. */
export function resolveProfile(
  config: AgentProfiles,
  agent: ChatAgent,
  ws: ProfileWorkspace,
  options: MatchOptions = {},
): ResolvedProfile {
  const rule = ruleFor(config, agent, ws, options);
  if (rule) {
    return {
      profile: profileOf(config, agent, rule[agent]),
      source: { kind: rule.target.kind, ruleId: rule.id },
    };
  }
  return { profile: profileOf(config, agent, config.defaults[agent]), source: { kind: "default" } };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/** The config with the profile added, or put in place of the one of its id. */
export function withProfile(config: AgentProfiles, profile: AgentProfile): AgentProfiles {
  const at = config.profiles.findIndex((p) => p.id === profile.id);
  const profiles = [...config.profiles];
  if (at >= 0) profiles[at] = profile;
  else profiles.push(profile);
  return { ...config, profiles };
}

/** The config without the profile, nor any rule or default naming it. */
function namedIt(rule: ProfileRule, id: string): boolean {
  return rule.claude === id || rule.codex === id;
}

export function withoutProfile(config: AgentProfiles, id: string): AgentProfiles {
  if (isDefaultProfileId(id)) return config;
  // A rule left with no agent by this goes; one the user left empty stays.
  const rules = config.rules.flatMap((rule) => {
    if (!namedIt(rule, id)) return [rule];
    const next = { ...rule };
    if (next.claude === id) delete next.claude;
    if (next.codex === id) delete next.codex;
    return next.claude !== undefined || next.codex !== undefined ? [next] : [];
  });
  const defaults = { ...config.defaults };
  if (defaults.claude === id) delete defaults.claude;
  if (defaults.codex === id) delete defaults.codex;
  return { profiles: config.profiles.filter((p) => p.id !== id), rules, defaults };
}

function sameTarget(a: ProfileTarget, b: ProfileTarget, options: MatchOptions): boolean {
  if (a.kind === "workspace" && b.kind === "workspace") return a.workspaceId === b.workspaceId;
  if (a.kind === "folder" && b.kind === "folder") {
    return normalizePath(a.path, options) === normalizePath(b.path, options);
  }
  if (a.kind === "ssh" && b.kind === "ssh") return a.host.toLowerCase() === b.host.toLowerCase();
  return false;
}

/** The rule for the target, if there is one. */
export function ruleOfTarget(
  config: AgentProfiles,
  target: ProfileTarget,
  options: MatchOptions = {},
): ProfileRule | undefined {
  return config.rules.find((rule) => sameTarget(rule.target, target, options));
}

/**
 * The config with the target's rule giving the agent that profile; `null`
 * leaves the agent to the next rule, and a rule left with no agent goes
 * unless `keepEmpty` (Settings keeps a rule the user is still filling in).
 */
export function withRuleProfile(
  config: AgentProfiles,
  target: ProfileTarget,
  agent: ChatAgent,
  profileId: string | null,
  newId: () => string,
  options: MatchOptions = {},
  keepEmpty = false,
): AgentProfiles {
  const existing = ruleOfTarget(config, target, options);
  const base: ProfileRule = existing ?? { id: newId(), target };
  const next: ProfileRule = { ...base };
  if (profileId === null) delete next[agent];
  else next[agent] = profileId;
  const keep = keepEmpty || next.claude !== undefined || next.codex !== undefined;
  const rules = existing
    ? config.rules.flatMap((rule) => (rule.id === existing.id ? (keep ? [next] : []) : [rule]))
    : keep
      ? [...config.rules, next]
      : config.rules;
  return { ...config, rules };
}

/** A folder name for a new profile's folder: "~/.claude-personal". */
export function suggestedProfileDir(
  agent: ChatAgent,
  name: string,
  taken: readonly string[],
): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "profile";
  const base = `${DEFAULT_PROFILE_DIR[agent]}-${slug}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** Whether a profile folder is the agent's default folder, which only the default profile has. */
export function isDefaultDir(agent: ChatAgent, dir: string, options: MatchOptions = {}): boolean {
  const trimmed = dir.trim();
  if (trimmed === "") return true;
  return normalizePath(trimmed, options) === normalizePath(DEFAULT_PROFILE_DIR[agent], options);
}

/** How a shareable entry reads in a list: a folder with its slash. */
export const SHARABLE_LABELS: Readonly<Record<string, string>> = {
  skills: "skills/",
  agents: "agents/",
  commands: "commands/",
  plugins: "plugins/",
  prompts: "prompts/",
  rules: "rules/",
};
