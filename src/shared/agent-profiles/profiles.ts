import { z } from "zod";
import type { ChatAgent } from "../sessions/task-agent";
import type { WorkspaceLocation } from "../types/workspace";
import { ProfileConnectionSchema } from "./connection";

export const PROFILE_AGENTS = ["claude", "codex"] as const satisfies readonly ChatAgent[];

export const PROFILE_COLORS = ["blue", "violet", "green", "amber", "rose", "cyan", "gray"] as const;
export type ProfileColor = (typeof PROFILE_COLORS)[number];

export const PROFILE_DIR_ENV: Record<ChatAgent, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
};

export const DEFAULT_PROFILE_DIR: Record<ChatAgent, string> = {
  claude: "~/.claude",
  codex: "~/.codex",
};

export const SHAREABLE: Record<ChatAgent, readonly string[]> = {
  claude: ["CLAUDE.md", "settings.json", "skills", "agents", "commands", "plugins"],
  codex: ["AGENTS.md", "config.toml", "prompts", "skills", "rules"],
};

export const SHARED_BY_DEFAULT: Record<ChatAgent, readonly string[]> = {
  claude: ["CLAUDE.md", "settings.json", "skills", "agents", "commands"],
  codex: ["AGENTS.md", "config.toml", "prompts", "skills"],
};

export function defaultProfileId(agent: ChatAgent): string {
  return `${agent}-default`;
}

export function isDefaultProfileId(id: string): boolean {
  return id === defaultProfileId("claude") || id === defaultProfileId("codex");
}

const ProfileIdSchema = z.string().min(1).max(64);
export const MAX_AGENT_PROFILES = 64;

const EnvKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

const agentProfileSchema = z.object({
  id: ProfileIdSchema,
  agent: z.enum(PROFILE_AGENTS),
  name: z.string().max(40),
  color: z.string().max(16),
  dir: z.string().max(1024),
  shared: z.array(z.string().max(64)).max(32).optional(),
  connection: ProfileConnectionSchema.optional(),
  env: z.record(EnvKeySchema, z.string().max(4096)).optional(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export const AgentProfileSchema: z.ZodType<AgentProfile> = agentProfileSchema;

export const ProfileTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace"), workspaceId: z.guid() }),
  z.object({ kind: z.literal("folder"), path: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("ssh"), host: z.string().min(1).max(255) }),
]);
export type ProfileTarget = z.infer<typeof ProfileTargetSchema>;
export type ProfileTargetKind = ProfileTarget["kind"];

export const ProfileRuleSchema = z.object({
  id: z.string().min(1).max(64),
  target: ProfileTargetSchema,
  claude: ProfileIdSchema.optional(),
  codex: ProfileIdSchema.optional(),
});
export type ProfileRule = z.infer<typeof ProfileRuleSchema>;

function lenientArray<T extends z.ZodType>(item: T, max: number) {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter((entry) => item.safeParse(entry).success).slice(0, max)
        : value,
    z.array(item).max(max),
  );
}

const agentProfilesSchema = z.object({
  profiles: lenientArray(AgentProfileSchema, MAX_AGENT_PROFILES),
  rules: lenientArray(ProfileRuleSchema, 512),
  defaults: z.object({ claude: ProfileIdSchema.optional(), codex: ProfileIdSchema.optional() }),
});
export type AgentProfiles = z.infer<typeof agentProfilesSchema>;
export const AgentProfilesSchema: z.ZodType<AgentProfiles, unknown> = agentProfilesSchema;

export const EMPTY_AGENT_PROFILES: AgentProfiles = { profiles: [], rules: [], defaults: {} };

const DEFAULT_COLORS: Record<ChatAgent, ProfileColor> = { claude: "blue", codex: "cyan" };

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
    ...(stored?.connection ? { connection: stored.connection } : {}),
  };
  return [first, ...config.profiles.filter((p) => p.agent === agent && p.id !== id)];
}

export function profileOf(
  config: AgentProfiles,
  agent: ChatAgent,
  id: string | undefined,
): AgentProfile {
  const all = profilesOf(config, agent);
  return all.find((p) => p.id === id) ?? (all[0] as AgentProfile);
}

export function hasProfile(config: AgentProfiles, agent: ChatAgent, id: string): boolean {
  return profilesOf(config, agent).some((p) => p.id === id);
}

export interface ProfileWorkspace {
  id: string;
  location: WorkspaceLocation;
  parent?: { id: string; location: WorkspaceLocation } | undefined;
}

export interface MatchOptions {
  windows?: boolean;
  home?: string;
}

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

function subjects(ws: ProfileWorkspace): { id: string; location: WorkspaceLocation }[] {
  return ws.parent ? [ws, ws.parent] : [ws];
}

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

export function withProfile(config: AgentProfiles, profile: AgentProfile): AgentProfiles {
  const at = config.profiles.findIndex((p) => p.id === profile.id);
  const profiles = [...config.profiles];
  if (at >= 0) profiles[at] = profile;
  else profiles.push(profile);
  return { ...config, profiles };
}

function namedIt(rule: ProfileRule, id: string): boolean {
  return rule.claude === id || rule.codex === id;
}

export function withoutProfile(config: AgentProfiles, id: string): AgentProfiles {
  if (isDefaultProfileId(id)) return config;
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

export function ruleOfTarget(
  config: AgentProfiles,
  target: ProfileTarget,
  options: MatchOptions = {},
): ProfileRule | undefined {
  return config.rules.find((rule) => sameTarget(rule.target, target, options));
}

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

export function suggestedProfileDir(
  agent: ChatAgent,
  name: string,
  taken: readonly string[],
  options: MatchOptions = {},
): string {
  const slug =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "profile";
  const base = `${DEFAULT_PROFILE_DIR[agent]}-${slug}`;
  const used = new Set(taken.map((dir) => normalizePath(portableProfileDir(dir), options)));
  if (!used.has(normalizePath(base, options))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(normalizePath(candidate, options))) return candidate;
  }
}

export function portableProfileDir(dir: string): string {
  const trimmed = dir.trim();
  return trimmed.startsWith("~\\") ? trimmed.replace(/\\/g, "/") : trimmed;
}

export function isDefaultDir(agent: ChatAgent, dir: string, options: MatchOptions = {}): boolean {
  const trimmed = dir.trim();
  if (trimmed === "") return true;
  return normalizePath(trimmed, options) === normalizePath(DEFAULT_PROFILE_DIR[agent], options);
}

export function profileDirConflict(
  agent: ChatAgent,
  dir: string,
  taken: readonly string[],
  options: MatchOptions = {},
  defaultDir?: string,
): "default" | "taken" | undefined {
  const normalized = (value: string) => normalizePath(portableProfileDir(value), options);
  const target = normalized(dir);
  if (
    isDefaultDir(agent, portableProfileDir(dir), options) ||
    (defaultDir && normalized(defaultDir) === target)
  ) {
    return "default";
  }
  if (taken.some((other) => other.trim() && normalized(other) === target)) return "taken";
}

export const SHARABLE_LABELS: Readonly<Record<string, string>> = {
  skills: "skills/",
  agents: "agents/",
  commands: "commands/",
  plugins: "plugins/",
  prompts: "prompts/",
  rules: "rules/",
};
