import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AgentProfile,
  type AgentProfiles,
  hasProfile,
  type MatchOptions,
  PROFILE_AGENTS,
  type ProfileRule,
  type ProfileTarget,
  type ProfileWorkspace,
  profileOf,
  profilesOf,
  resolveProfile,
  ruleMatches,
  ruleOfTarget,
  withRuleProfile,
} from "../../../../shared/agent-profiles/profiles";
import { CONSENT_AGENT_NAMES, type ProfileRuleCopy } from "../../../../shared/cli/consent-copy";
import type { CliChange } from "../../../../shared/cli/ui";
import type { ChatAgent } from "../../../../shared/sessions/task-agent";
import type { WorkspaceMeta } from "../../../../shared/types/workspace";
import { shortId } from "../../../../shared/util/short-id";
import { expandHome } from "../../agent-profiles/local";
import { parseSshConfig } from "../../ssh/config";
import { CliUsageError, exactArgs, type FlagSpec, type FlagValues } from "../args";
import { type CliContext, CliError, mayChange, resolveWorkspace } from "../context";
import { oneLine, table } from "../format";
import { callerPath, onAppMachine } from "../paths";
import { type CliCommand, output } from "../registry";
import { chatAgentFlag } from "./chat";
import { localProfile, profileName, refuseDevice, THIS_COMPUTER_FLAG } from "./chat-profiles";

const AGENT_FLAG = {
  type: "string",
  value: "AGENT",
  description: "claude or codex (the profile's agent by default)",
} as const satisfies FlagSpec;

export interface RulesOptions {
  matching?: MatchOptions;
  sshConfig?: string;
}

function matchingOf(options: RulesOptions): MatchOptions {
  return options.matching ?? { home: os.homedir(), windows: process.platform === "win32" };
}

function subjectOf(workspace: WorkspaceMeta, all: readonly WorkspaceMeta[]): ProfileWorkspace {
  const parentId = workspace.task?.parentId;
  const parent = parentId ? all.find((w) => w.id === parentId) : undefined;
  return {
    id: workspace.id,
    location: workspace.location,
    ...(parent ? { parent: { id: parent.id, location: parent.location } } : {}),
  };
}

function appliesTo(rule: ProfileRule, all: readonly WorkspaceMeta[], matching: MatchOptions) {
  return all.filter((w) => !w.task && ruleMatches(rule, subjectOf(w, all), matching)).length;
}

function tilde(dir: string, matching: MatchOptions): string {
  const home = matching.home;
  if (!home) return dir;
  if (dir === home) return "~";
  const sep = matching.windows ? /[\\/]/ : /\//;
  return dir.startsWith(home) && sep.test(dir.charAt(home.length))
    ? `~${dir.slice(home.length)}`
    : dir;
}

function targetName(
  target: ProfileTarget,
  all: readonly WorkspaceMeta[],
  matching: MatchOptions,
): string {
  if (target.kind === "folder") return tilde(target.path, matching);
  if (target.kind === "ssh") return target.host;
  return all.find((w) => w.id === target.workspaceId)?.name ?? shortId(target.workspaceId);
}

interface ProfileRef {
  id: string;
  name: string;
}

function refOf(config: AgentProfiles, agent: ChatAgent, id: string | undefined) {
  if (id === undefined) return undefined;
  const profile = profilesOf(config, agent).find((p) => p.id === id);
  return { id, name: profile ? profileName(profile) : id } satisfies ProfileRef;
}

function routingOf(config: AgentProfiles): string {
  return JSON.stringify({ rules: config.rules, defaults: config.defaults });
}

function ruleView(
  config: AgentProfiles,
  rule: ProfileRule,
  all: readonly WorkspaceMeta[],
  matching: MatchOptions,
) {
  const { target } = rule;
  const claude = refOf(config, "claude", rule.claude);
  const codex = refOf(config, "codex", rule.codex);
  return {
    id: rule.id,
    target: { ...target, name: targetName(target, all, matching) },
    ...(claude ? { claude } : {}),
    ...(codex ? { codex } : {}),
    applies: appliesTo(rule, all, matching),
  };
}

type RuleView = ReturnType<typeof ruleView>;

function rulesTable(rules: readonly RuleView[]): string {
  return table(
    ["TARGET", "KIND", "CLAUDE", "CODEX", "APPLIES", "ID"],
    rules.map((rule) => [
      oneLine(rule.target.name, 80),
      rule.target.kind,
      rule.claude ? oneLine(rule.claude.name, 40) : "inherit",
      rule.codex ? oneLine(rule.codex.name, 40) : "inherit",
      String(rule.applies),
      shortId(rule.id),
    ]),
  );
}

function defaultsOf(config: AgentProfiles) {
  return PROFILE_AGENTS.map((agent) => {
    const profile = profileOf(config, agent, config.defaults[agent]);
    return { agent, id: profile.id, name: profileName(profile) };
  });
}

function ask(ctx: CliContext, toWorkspaceId: string, change: CliChange) {
  return ctx.services.askUser(
    {
      fromWorkspaceId: ctx.caller.workspaceId,
      fromTabId: ctx.caller.tabId,
      toWorkspaceId,
      change: { ...change, eachTime: true },
    },
    ctx.signal,
  );
}

function unchanged(ctx: CliContext, before: string): AgentProfiles {
  ctx.signal?.throwIfAborted();
  const now = ctx.services.profileConnections.config();
  if (routingOf(now) !== before) {
    throw new CliError(
      "The profile rules or defaults changed while waiting for approval; run the command again",
    );
  }
  return now;
}

export const chatProfilesDefault = {
  path: ["chat", "profiles", "default"],
  summary: "Show or change the default profile of each agent on this computer",
  args: "[profile]",
  details:
    "Without a profile, prints the profile each agent uses where no rule matches. With one (its\n" +
    "name or id; --agent when a Claude and a Codex profile share it), makes it that agent's default\n" +
    "with the user's approval each time, as Settings › Agents › Rules › Defaults does. New tabs use it.",
  flags: { agent: AGENT_FLAG, device: THIS_COMPUTER_FLAG },
  async run(ctx, { flags, positionals }) {
    refuseDevice(flags, "chat profiles default");
    const [selector, ...extra] = positionals;
    if (extra.length) throw new CliUsageError("Give at most one <profile>");
    const agentFilter =
      flags.agent === undefined ? undefined : chatAgentFlag(flags.agent, "claude");
    const connections = ctx.services.profileConnections;
    const config = connections.config();
    if (selector === undefined) {
      const defaults = defaultsOf(config).filter(
        ({ agent }) => agentFilter === undefined || agent === agentFilter,
      );
      return output(
        table(
          ["AGENT", "DEFAULT PROFILE", "ID"],
          defaults.map((row) => [row.agent, oneLine(row.name, 80), row.id]),
        ),
        { defaults },
        { records: defaults },
      );
    }
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const profile = localProfile(ctx, selector, agentFilter);
    const { agent } = profile;
    const current = profileOf(config, agent, config.defaults[agent]);
    if (current.id === profile.id) {
      throw new CliUsageError(
        `"${oneLine(profileName(profile), 80)}" is already the default ${agent} profile`,
      );
    }
    const before = routingOf(config);
    await ask(ctx, ctx.caller.workspaceId, {
      kind: "profileDefault",
      detail: CONSENT_AGENT_NAMES[agent],
      profileDefault: { agent, from: profileName(current), to: profileName(profile) },
    });
    const now = unchanged(ctx, before);
    if (!hasProfile(now, agent, profile.id)) {
      throw new CliError("The profile was removed while waiting for approval");
    }
    connections.saveRouting({
      rules: now.rules,
      defaults: { ...now.defaults, [agent]: profile.id },
    });
    const row = { agent, id: profile.id, name: profileName(profile) };
    return output(
      `The default ${agent} profile is now "${oneLine(row.name, 80)}" (${row.id}). New tabs use it.`,
      { ...row, from: { id: current.id, name: profileName(current) } },
    );
  },
} satisfies CliCommand;

const TARGET_FLAGS = {
  folder: {
    type: "string",
    value: "PATH",
    description: "A folder and its subfolders (relative to the current folder)",
  },
  ssh: {
    type: "string",
    value: "HOST",
    description: "An SSH host from ~/.ssh/config or a workspace",
  },
  workspace: { type: "string", value: "WS", description: "A workspace by name or id" },
} as const satisfies Record<string, FlagSpec>;

type TargetFlag = keyof typeof TARGET_FLAGS;

function targetFlag(flags: FlagValues): { flag: TargetFlag; value: string } | undefined {
  const given = (Object.keys(TARGET_FLAGS) as TargetFlag[]).filter(
    (flag) => flags[flag] !== undefined,
  );
  if (given.length > 1) {
    throw new CliUsageError("Give one of --folder, --ssh or --workspace");
  }
  const [flag] = given;
  if (flag === undefined) return undefined;
  const raw = flags[flag];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length > 1024 || /\p{Cc}/u.test(value)) {
    throw new CliUsageError(`Give --${flag} a value without control characters`);
  }
  return { flag, value };
}

async function knownSshHosts(ctx: CliContext, configPath: string): Promise<string[]> {
  const fromWorkspaces = ctx.services
    .listWorkspaces()
    .flatMap(({ location }) =>
      location.kind === "ssh" ? [location.configAlias || location.host || ""] : [],
    );
  const text = await readFile(configPath, "utf8").catch(() => "");
  const fromConfig = parseSshConfig(text).map(({ alias }) => alias);
  return [...new Set([...fromWorkspaces, ...fromConfig])].filter(
    (host) => host !== "" && !host.includes("*"),
  );
}

interface Target {
  target: ProfileTarget;
  workspace?: WorkspaceMeta;
}

async function targetOf(
  ctx: CliContext,
  given: { flag: TargetFlag; value: string },
  options: RulesOptions,
  existing: boolean,
): Promise<Target> {
  const matching = matchingOf(options);
  if (given.flag === "folder") {
    const input = given.value;
    const absolute =
      input === "~" || input.startsWith("~/") || input.startsWith("~\\")
        ? path.resolve(expandHome(input, matching.home))
        : callerPath(ctx, input);
    if (!existing) {
      const found = await stat(absolute).catch(() => null);
      if (!found?.isDirectory()) throw new CliUsageError(`--folder: ${absolute} is not a folder`);
    }
    return { target: { kind: "folder", path: absolute } };
  }
  if (given.flag === "ssh") {
    const host = given.value;
    if (existing) return { target: { kind: "ssh", host } };
    if (/[\s*?]/.test(host) || host.length > 255) {
      throw new CliUsageError("--ssh takes one host name without spaces or wildcards");
    }
    const known = await knownSshHosts(
      ctx,
      options.sshConfig ?? path.join(os.homedir(), ".ssh", "config"),
    );
    const match = known.find((name) => name.toLowerCase() === host.toLowerCase());
    if (!match) {
      throw new CliUsageError(
        `--ssh: "${oneLine(host, 80)}" is not a host of ~/.ssh/config or an SSH workspace`,
      );
    }
    return { target: { kind: "ssh", host: match } };
  }
  const workspace = resolveWorkspace(ctx, given.value);
  if (workspace.task) {
    throw new CliUsageError(
      "A worktree task follows its parent workspace's rule; give the parent workspace",
    );
  }
  return { target: { kind: "workspace", workspaceId: workspace.id }, workspace };
}

function ruleChange(
  config: AgentProfiles,
  rule: ProfileRule,
  copy: Omit<ProfileRuleCopy, "target" | "applies">,
  all: readonly WorkspaceMeta[],
  matching: MatchOptions,
): CliChange {
  const name = targetName(rule.target, all, matching);
  return {
    kind: "profileRule",
    detail: name,
    profileRule: {
      target: { kind: rule.target.kind, name },
      applies: appliesTo(rule, all, matching),
      ...copy,
      lines: copy.lines.map((line) => ({
        agent: line.agent,
        ...(line.from !== undefined
          ? { from: line.from && (refOf(config, line.agent, line.from)?.name ?? line.from) }
          : {}),
        ...(line.to !== undefined
          ? { to: line.to && (refOf(config, line.agent, line.to)?.name ?? line.to) }
          : {}),
      })),
    },
  };
}

async function guardWorkspace(ctx: CliContext, target: Target, change: CliChange) {
  if (target.workspace) await mayChange(ctx, target.workspace, change);
}

interface AgentChoice {
  id: string;
  name: string;
  source: ProfileTarget["kind"] | "default";
  rule?: string;
}

function workspaceChoice(ctx: CliContext, config: AgentProfiles, matching: MatchOptions) {
  const all = ctx.services.listWorkspaces();
  const own = all.find((w) => w.id === ctx.caller.workspaceId);
  if (!own) return undefined;
  const subject = subjectOf(own, all);
  const choose = (agent: ChatAgent): AgentChoice => {
    const { profile, source } = resolveProfile(config, agent, subject, matching);
    return {
      id: profile.id,
      name: profileName(profile),
      source: source.kind,
      ...("ruleId" in source ? { rule: source.ruleId } : {}),
    };
  };
  return { id: own.id, name: own.name, claude: choose("claude"), codex: choose("codex") };
}

function choiceText(choice: NonNullable<ReturnType<typeof workspaceChoice>>): string {
  const parts = PROFILE_AGENTS.map((agent) => {
    const { name, source } = choice[agent];
    const why = source === "default" ? "default" : `${source} rule`;
    return `${CONSENT_AGENT_NAMES[agent]} ${oneLine(name, 40)} (${why})`;
  });
  return `This workspace (${oneLine(choice.name, 80)}): ${parts.join(" · ")}`;
}

export const chatProfilesRules = {
  path: ["chat", "profiles", "rules"],
  summary: "List the rules that choose a profile by workspace, folder or SSH host",
  details:
    "As Settings › Agents › Rules: a workspace rule wins over a deeper folder rule, which wins over\n" +
    "an SSH host rule; workspaces no rule matches use the default (chat profiles default).\n" +
    "inherit means the rule leaves that agent to the next rule or the default. APPLIES counts the\n" +
    "workspaces the rule matches. The last line shows what this workspace uses.\n" +
    "Change them on this computer with chat profiles rules set and rules remove.",
  flags: { device: THIS_COMPUTER_FLAG },
  async run(ctx, { flags, positionals }, options: RulesOptions = {}) {
    exactArgs(positionals);
    refuseDevice(flags, "chat profiles rules");
    const matching = matchingOf(options);
    const config = ctx.services.profileConnections.config();
    const all = ctx.services.listWorkspaces();
    const rules = config.rules.map((rule) => ruleView(config, rule, all, matching));
    const defaults = defaultsOf(config);
    const choice = workspaceChoice(ctx, config, matching);
    const text = [
      `Defaults: ${defaults
        .map(({ agent, name }) => `${CONSENT_AGENT_NAMES[agent]} ${oneLine(name, 40)}`)
        .join(" · ")}`,
      rules.length ? rulesTable(rules) : "No rules.",
      ...(choice ? [choiceText(choice)] : []),
    ].join("\n\n");
    return output(
      text,
      { rules, defaults, ...(choice ? { workspace: choice } : {}) },
      { records: rules },
    );
  },
} satisfies CliCommand;

export const chatProfilesRulesSet = {
  path: ["chat", "profiles", "rules", "set"],
  summary: "Choose an agent's profile for a workspace, folder or SSH host with the user's approval",
  details:
    "Give one target: --folder PATH (an existing folder; its subfolders too), --ssh HOST (a host of\n" +
    "~/.ssh/config or an SSH workspace) or --workspace WS (not a worktree task: tasks follow their\n" +
    "parent). Then --profile NAME, or --inherit with --agent to let that agent fall back to the next\n" +
    "rule or the default. --agent is needed when the profile name is used by both agents. A target\n" +
    "with a rule already changes that rule. The user approves each time; a rule for another\n" +
    "workspace also follows the setting for changing other workspaces. New tabs use it.",
  flags: {
    ...TARGET_FLAGS,
    agent: AGENT_FLAG,
    profile: { type: "string", value: "NAME", description: "The profile by name or id" },
    inherit: { type: "boolean", description: "Leave the agent to the next rule or the default" },
    device: THIS_COMPUTER_FLAG,
  },
  async run(ctx, { flags, positionals }, options: RulesOptions = {}) {
    exactArgs(positionals);
    refuseDevice(flags, "chat profiles rules set");
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const given = targetFlag(flags);
    if (!given) throw new CliUsageError("Give --folder PATH, --ssh HOST or --workspace WS");
    const inherit = flags.inherit === true;
    if (inherit === (flags.profile !== undefined)) {
      throw new CliUsageError("Give --profile NAME or --inherit");
    }
    const agentFilter =
      flags.agent === undefined ? undefined : chatAgentFlag(flags.agent, "claude");
    if (inherit && agentFilter === undefined) {
      throw new CliUsageError("--inherit needs --agent claude or codex");
    }
    let profile: AgentProfile | undefined;
    if (!inherit) {
      const selector = typeof flags.profile === "string" ? flags.profile.trim() : "";
      if (!selector || selector.length > 64) {
        throw new CliUsageError("--profile takes a profile name or id of up to 64 characters");
      }
      profile = profileFor(ctx, selector, agentFilter);
    }
    const agent = (profile?.agent ?? agentFilter) as ChatAgent;
    const matching = matchingOf(options);
    const target = await targetOf(ctx, given, options, false);
    const connections = ctx.services.profileConnections;
    const config = connections.config();
    const all = ctx.services.listWorkspaces();
    const existing = ruleOfTarget(config, target.target, matching);
    const from = existing?.[agent] ?? null;
    const to = profile?.id ?? null;
    if (!existing && to === null) {
      throw new CliUsageError("No rule for this target; nothing to change");
    }
    if (existing && from === to) throw new CliUsageError("Nothing to change");
    const next = withRuleProfile(config, target.target, agent, to, randomUUID, matching, true);
    const rule = ruleOfTarget(next, target.target, matching) as ProfileRule;
    const change = ruleChange(
      next,
      rule,
      { lines: [{ agent, ...(existing ? { from } : {}), to }] },
      all,
      matching,
    );
    const before = routingOf(config);
    await guardWorkspace(ctx, target, change);
    await ask(ctx, target.workspace?.id ?? ctx.caller.workspaceId, change);
    const now = unchanged(ctx, before);
    if (profile && !hasProfile(now, agent, profile.id)) {
      throw new CliError("The profile was removed while waiting for approval");
    }
    connections.saveRouting({ rules: next.rules, defaults: now.defaults });
    const view = ruleView(next, rule, all, matching);
    const choice = workspaceChoice(ctx, next, matching);
    return output([rulesTable([view]), ...(choice ? [choiceText(choice)] : [])].join("\n\n"), {
      ...view,
      changed: [agent],
      ...(existing ? {} : { added: true }),
      ...(choice ? { workspace: choice } : {}),
    });
  },
} satisfies CliCommand;

function profileFor(ctx: CliContext, selector: string, agent: ChatAgent | undefined) {
  if (agent === undefined) return localProfile(ctx, selector, undefined);
  try {
    return localProfile(ctx, selector, agent);
  } catch (error) {
    const other: ChatAgent = agent === "claude" ? "codex" : "claude";
    const found = (() => {
      try {
        return localProfile(ctx, selector, other);
      } catch {
        return undefined;
      }
    })();
    if (found) {
      throw new CliUsageError(
        `"${oneLine(selector, 64)}" is a ${other} profile; give --agent ${other} or a ${agent} profile`,
      );
    }
    throw error;
  }
}

export const chatProfilesRulesRemove = {
  path: ["chat", "profiles", "rules", "remove"],
  summary: "Remove a profile rule on this computer with the user's approval",
  args: "[rule]",
  details:
    "Give the rule's id (or its start) from chat profiles rules, or its target with --folder,\n" +
    "--ssh or --workspace. Workspaces it matched fall back to the next rule or the default. The\n" +
    "user approves each time; a rule for another workspace also follows the setting for changing\n" +
    "other workspaces.",
  flags: {
    folder: TARGET_FLAGS.folder,
    ssh: { type: "string", value: "HOST", description: "An SSH host" },
    workspace: TARGET_FLAGS.workspace,
    device: THIS_COMPUTER_FLAG,
  },
  async run(ctx, { flags, positionals }, options: RulesOptions = {}) {
    refuseDevice(flags, "chat profiles rules remove");
    if (!onAppMachine(ctx)) throw new CliError("Run this command in a local workspace");
    const [selector, ...extra] = positionals;
    if (extra.length) throw new CliUsageError("Give one <rule>");
    const given = targetFlag(flags);
    if ((selector === undefined) === (given === undefined)) {
      throw new CliUsageError("Give a <rule> id or one of --folder, --ssh or --workspace");
    }
    const matching = matchingOf(options);
    const connections = ctx.services.profileConnections;
    const config = connections.config();
    const all = ctx.services.listWorkspaces();
    let rule: ProfileRule | undefined;
    let target: Target | undefined;
    if (given) {
      target = await targetOf(ctx, given, options, true);
      rule = ruleOfTarget(config, target.target, matching);
      if (!rule) throw new CliError("No rule for this target. See nexus chat profiles rules.");
    } else {
      const wanted = (selector as string).trim().toLowerCase();
      const matches = config.rules.filter(
        (r) => r.id.toLowerCase() === wanted || (wanted.length >= 4 && r.id.startsWith(wanted)),
      );
      if (matches.length > 1) throw new CliError(`more than one rule starts with "${wanted}"`);
      rule = matches[0];
      if (!rule) {
        throw new CliError(`no rule "${oneLine(wanted, 64)}". See nexus chat profiles rules.`);
      }
      const { target: ruleTarget } = rule;
      const workspace =
        ruleTarget.kind === "workspace"
          ? all.find((w) => w.id === ruleTarget.workspaceId)
          : undefined;
      target = { target: rule.target, ...(workspace ? { workspace } : {}) };
    }
    const found = rule;
    const lines = PROFILE_AGENTS.flatMap((agent) =>
      found[agent] === undefined ? [] : [{ agent, from: found[agent] }],
    );
    const change = ruleChange(config, found, { lines, removed: true }, all, matching);
    const before = routingOf(config);
    await guardWorkspace(ctx, target, change);
    await ask(ctx, target.workspace?.id ?? ctx.caller.workspaceId, change);
    const now = unchanged(ctx, before);
    connections.saveRouting({
      rules: now.rules.filter(({ id }) => id !== found.id),
      defaults: now.defaults,
    });
    const view = ruleView(config, found, all, matching);
    const choice = workspaceChoice(ctx, connections.config(), matching);
    return output(
      [
        `Removed the rule for ${view.target.kind} ${oneLine(view.target.name, 80)}.`,
        ...(choice ? [choiceText(choice)] : []),
      ].join("\n"),
      { ...view, removed: true, ...(choice ? { workspace: choice } : {}) },
    );
  },
} satisfies CliCommand;
