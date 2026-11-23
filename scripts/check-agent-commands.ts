import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noteReport } from "../src/main/features/cli/commands/note-report";
import { commandHelp } from "../src/main/features/cli/registry";
import { APP_COMMANDS, type AppCommand } from "../src/renderer/services/chat/app-commands";
import {
  CONFIG_KEYS,
  type ListedKey,
  parseConfigUsage,
} from "../src/renderer/services/chat/claude/config";
import { CODEX_COMMANDS } from "../src/renderer/services/chat/codex/commands";
import { THREAD_STATUS_CHANGED } from "../src/renderer/services/chat/codex/model";

const OFF = "off in its definition";
const TERMINAL = "the terminal's own UI";

const CLAUDE_LEFT_OUT: Record<string, string> = {
  artifacts: "a terminal browser of claude.ai's artifacts",
  brief: "the terminal's brief-only display",
  bug: "the same as /feedback, which the tab runs",
  cd: "moves the session; a tab's folder is fixed",
  chrome: "Claude in Chrome's settings",
  "cloud-plugins": "a setting of cloud sessions",
  daemon: "background services, in the terminal",
  desktop: "hands the session to Claude Desktop",
  "design-login": "a claude.ai sign-in for /design-sync, in the terminal",
  ide: "IDE integration; the app is the editor",
  install: "installs the CLI itself",
  keybindings: TERMINAL,
  loops: OFF,
  mobile: "a QR code for the mobile app",
  passes: "a referral offer the CLI shows",
  "pause-memory": OFF,
  powerup: "lessons in the terminal",
  "pro-trial-expired": "a plan prompt the CLI shows",
  project: "a claude.ai Project for usage reports, behind a flag",
  radio: "a novelty of the terminal",
  "rate-limit-options": "a plan prompt the CLI shows",
  rewind: "the tab rewinds from a message's menu",
  "scroll-speed": TERMINAL,
  session: "a cloud session's URL and QR code",
  statusline: TERMINAL,
  stickers: "a novelty of the terminal",
  stop: "a background session's own; the app stops those itself",
  "terminal-setup": TERMINAL,
  theme: TERMINAL,
  tui: TERMINAL,
  "use-case": "an account-gated picker (Life Sciences)",
  version: OFF,
  voice: "dictation in the terminal",
  wellbeing: OFF,
};

const CLAUDE_LEFT_OUT_WHEN_UNAVAILABLE: Record<string, string> = {
  advisor: "chooses a second model for advice when the advisor tool is enabled",
  "extra-usage": "the former name of /usage-credits, gated by the same billing options",
  import: "imports another agent's configuration when the import feature is enabled",
  "skill-doctor": "reports skill usage and context cost when feature-flag fetching is enabled",
  ultrareview: "runs a cloud code review on eligible accounts",
  "usage-credits": "manages usage credits or requests them from an admin on eligible accounts",
};

const CLAUDE_SIGN_IN_CONFIG_KEYS = new Set([
  "remoteControl",
  "agentPushNotifEnabled",
  "inputNeededNotifEnabled",
  "promptSuggestionEnabled",
]);

const CLAUDE_LATER: Record<string, string> = {
  restart:
    "restarts the program, keeping the session; the tab offers it only after a failure or a terminal command",
};

const CLAUDE_APP_ONLY: Record<string, string> = {};

const CODEX_LEFT_OUT: Record<string, string> = {
  agents: "the TUI's views of its agents",
  app: "hands the session to the Codex desktop app",
  approve: "auto-review denials; the tab has its own approvals",
  cd: "moves the session; a tab's folder is fixed",
  daemon: "Codex's background server, in the terminal",
  daybreak: "a TUI feature toggle",
  "debug-config": "for debugging Codex",
  "debug-m-drop": "for debugging Codex",
  "debug-m-update": "for debugging Codex",
  feedback: "sends Codex's logs to OpenAI",
  ide: "IDE context; the app is the editor",
  import: "imports Claude Code's setup into Codex, once",
  keymap: TERMINAL,
  mention: "the composer's @-mentions",
  permissions: "the composer's preset chip",
  pets: TERMINAL,
  presets: "the TUI's saved prompts",
  ps: "the TUI's background terminals",
  pwd: "the tab shows its folder",
  raw: TERMINAL,
  rollout: "for debugging Codex",
  "setup-default-sandbox": "Windows sandbox setup, in the terminal",
  statusline: TERMINAL,
  stop: "the TUI's background terminals",
  subagents: "the TUI's views of its agents",
  "test-approval": "for debugging Codex",
  theme: TERMINAL,
  title: TERMINAL,
  tui: TERMINAL,
  vim: TERMINAL,
  voice: "dictation in the terminal",
  warnings: "for debugging Codex",
  worktree: "the app makes worktrees as tasks of its own",
};

const CODEX_LATER: Record<string, string> = {
  apps: "app/list",
  archive: "thread/archive",
  btw: "an ephemeral thread/fork",
  delete: "thread/delete",
  experimental: "experimentalFeature/list, experimentalFeature/enablement/set",
  hooks: "hooks/list",
  memories: "config/value/write",
  plugins: "plugin/list",
  recap: "a turn of its own",
  side: "an ephemeral thread/fork",
};

const CODEX_APP_ONLY: Record<string, string> = {
  context: "opens the tab's context panel; the TUI reports context under /status",
  default: "returns to Default collaboration mode; the TUI uses its mode switcher",
  effort: "Codex's /model picks it; the tab has a chip for each",
  help: "lists the tab's commands",
};

const ROOT = path.join(import.meta.dir, "..");

interface CliCommand {
  name: string;
  aliases: string[];
  off?: boolean;
}

interface Report {
  title: string;
  problems: string[];
  notes: string[];
}

function run(command: string, args: string[], exitCodes: readonly number[] = [0]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status === null || !exitCodes.includes(result.status)) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function findProgram(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    if (!existsSync(candidate)) continue;
    if (readFileSync(candidate).subarray(0, 2).toString("latin1") === "#!") continue;
    return realpathSync(candidate);
  }
  throw new Error(`no ${name} program on PATH`);
}

function namesOf(commands: readonly AppCommand[]): Set<string> {
  return new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
}

function slashed(names: Iterable<string>): string {
  return [...names]
    .sort()
    .map((n) => `/${n}`)
    .join(" ");
}

function accountFor(
  agent: string,
  cli: readonly CliCommand[],
  tables: {
    fromCli: ReadonlySet<string>;
    app: readonly AppCommand[];
    appTable: string;
    leftOut: Record<string, string>;
    later: Record<string, string>;
    appOnly: Record<string, string>;
  },
): { problems: string[]; notes: string[] } {
  const { fromCli, app, appTable, leftOut, later, appOnly } = tables;
  const problems: string[] = [];
  const cliNames = new Set(cli.flatMap((c) => [c.name, ...c.aliases]));
  const byName = new Map(cli.map((c) => [c.name, c]));
  const appNames = namesOf(app);

  for (const c of cli) {
    if (fromCli.has(c.name) || appNames.has(c.name) || c.name in leftOut || c.name in later) {
      continue;
    }
    problems.push(
      `/${c.name}${c.off ? " (off)" : ""}: ${agent} has it; the tab neither runs it nor leaves it out`,
    );
  }
  for (const command of app) {
    if (fromCli.has(command.name)) {
      problems.push(
        `/${command.name}: the CLI runs it headless now, so the tab's own (${appTable}) is never used`,
      );
    } else if (!cliNames.has(command.name) && !(command.name in appOnly)) {
      problems.push(
        `/${command.name}: the tab runs it (${appTable}), but ${agent} no longer has it`,
      );
    }
  }
  const listed: [string, Record<string, string>][] = [
    ["left out", leftOut],
    ["to do later", later],
  ];
  for (const [label, table] of listed) {
    for (const [name, reason] of Object.entries(table)) {
      const command = byName.get(name);
      if (appNames.has(name)) problems.push(`/${name}: listed as ${label}, but the tab runs it`);
      else if (fromCli.has(name))
        problems.push(`/${name}: listed as ${label}, but the CLI runs it headless now`);
      else if (!command)
        problems.push(`/${name}: listed as ${label}, but ${agent} no longer has it`);
      else if (reason === OFF && !command.off)
        problems.push(`/${name}: left out as off, but it is on now`);
    }
  }
  for (const name of Object.keys(appOnly)) {
    if (cliNames.has(name))
      problems.push(`/${name}: listed as the tab's own, but ${agent} has it now`);
    else if (!appNames.has(name))
      problems.push(`/${name}: listed as the tab's own, but the tab does not run it`);
  }

  const offNames = Object.keys(leftOut).filter((n) => leftOut[n] === OFF);
  const notes = [
    `${cli.length} commands: ${fromCli.size > 0 ? `${[...fromCli].filter((n) => byName.has(n)).length} from the CLI, ` : ""}the tab runs ${app.length}, ${Object.keys(leftOut).length} left out (${offNames.length} off), ${Object.keys(later).length} to do later`,
    ...Object.entries(later).map(([name, why]) => `later: /${name} (${why})`),
    ...(Object.keys(appOnly).length > 0 ? [`the tab's own: ${slashed(Object.keys(appOnly))}`] : []),
  ];
  return { problems, notes };
}

const COMMAND_TYPE = 'type:"(?:local-jsx|local|prompt)"';
const NAME = 'name:"([a-z][a-z0-9-]*)"';

export function claudeCommandsIn(bundle: string): CliCommand[] {
  const found = new Map<string, CliCommand>();
  const patterns = [
    new RegExp(`${COMMAND_TYPE},${NAME}`, "g"),
    new RegExp(`${NAME},(?:(?!name:")[\\s\\S]){0,1500}?${COMMAND_TYPE}`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of bundle.matchAll(pattern)) {
      const name = match[1];
      const end = (match.index ?? 0) + match[0].length;
      const rest = bundle.slice(end, end + 800);
      const stop = [new RegExp(COMMAND_TYPE), /name:"/, /;var /]
        .map((re) => rest.search(re))
        .filter((i) => i !== -1);
      const body = match[0] + rest.slice(0, Math.min(rest.length, ...stop));
      const aliases = /aliases:\[([^\]]*)\]/.exec(body)?.[1].match(/[a-z][a-z0-9-]*/g) ?? [];
      const off = /isEnabled:\(\)=>!1/.test(body);
      const known = found.get(name);
      if (known) {
        known.aliases = [...new Set([...known.aliases, ...aliases])];
        known.off ||= off;
      } else {
        found.set(name, { name, aliases, ...(off ? { off } : {}) });
      }
    }
  }
  return [...found.values()];
}

function claudeHeadless(program: string): { commands: string[]; configUsage: string } {
  const stdout = run(program, [
    "-p",
    "--no-session-persistence",
    "--settings",
    '{"disableAllHooks":true,"env":{"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS":"1"}}',
    "--output-format",
    "stream-json",
    "--verbose",
    "/config",
  ]);
  let commands: string[] = [];
  let configUsage = "";
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const message = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      slash_commands?: string[];
      result?: string;
    };
    if (message.type === "system" && message.subtype === "init") {
      commands = message.slash_commands ?? [];
    }
    if (message.type === "result" && typeof message.result === "string") {
      configUsage = message.result;
    }
  }
  return { commands, configUsage };
}

function claudeSignedOut(program: string): boolean {
  const status = JSON.parse(run(program, ["auth", "status", "--json"], [0, 1])) as {
    loggedIn?: boolean;
  };
  if (typeof status?.loggedIn !== "boolean") throw new Error("no loggedIn in claude auth status");
  return !status.loggedIn;
}

export function claudeConfigProblems(listed: readonly ListedKey[], signedOut: boolean): string[] {
  if (listed.length === 0) return ["/config: no keys in a bare /config's answer"];
  const problems: string[] = [];
  const listedKeys = new Set(listed.map((k) => k.key));
  const tableKeys = new Set(CONFIG_KEYS.map((k) => k.key));
  for (const key of listedKeys) {
    if (!tableKeys.has(key)) {
      problems.push(
        `/config ${key}: new; the settings dialog shows it under Other, its value read from nowhere (CONFIG_KEYS)`,
      );
    }
  }
  for (const key of tableKeys) {
    if (listedKeys.has(key) || (signedOut && CLAUDE_SIGN_IN_CONFIG_KEYS.has(key))) continue;
    problems.push(`/config ${key}: Claude Code no longer lists it (CONFIG_KEYS)`);
  }
  return problems;
}

function checkClaude(): Report {
  const program = findProgram("claude");
  const version = run(program, ["--version"]).trim().split(/\s+/)[0];
  const cli = claudeCommandsIn(readFileSync(program).toString("latin1"));
  const headless = claudeHeadless(program);
  const fromCli = new Set(headless.commands);
  const { problems, notes } = accountFor("Claude Code", cli, {
    fromCli,
    app: APP_COMMANDS,
    appTable: "APP_COMMANDS",
    leftOut: {
      ...CLAUDE_LEFT_OUT,
      ...Object.fromEntries(
        Object.entries(CLAUDE_LEFT_OUT_WHEN_UNAVAILABLE).filter(([name]) => !fromCli.has(name)),
      ),
    },
    later: CLAUDE_LATER,
    appOnly: CLAUDE_APP_ONLY,
  });

  const listed = parseConfigUsage(headless.configUsage);
  problems.push(...claudeConfigProblems(listed, claudeSignedOut(program)));
  notes.push(`/config: ${listed.length} keys, the table ${CONFIG_KEYS.length}`);
  return { title: `Claude Code ${version} (${program})`, problems, notes };
}

function kebab(variant: string): string {
  return variant.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function codexCommandsIn(source: string): CliCommand[] {
  const body = /pub enum SlashCommand \{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!body) throw new Error("no SlashCommand enum in the source");
  const commands: CliCommand[] = [];
  let attribute = "";
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("#[strum(")) {
      attribute = line;
      continue;
    }
    const variant = /^([A-Z]\w*),?$/.exec(line)?.[1];
    if (!variant) continue;
    const display = /to_string\s*=\s*"([^"]+)"/.exec(attribute)?.[1];
    const serialized = [...attribute.matchAll(/serialize\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
    const name = display ?? serialized[0] ?? kebab(variant);
    commands.push({ name, aliases: serialized.filter((s) => s !== name) });
    attribute = "";
  }
  return commands;
}

export function codexServiceTierCommandsIn(catalog: string): CliCommand[] {
  const { models } = JSON.parse(catalog) as {
    models?: { service_tiers?: { name: string }[] }[];
  };
  if (!Array.isArray(models)) throw new Error("no models in Codex's bundled model catalog");
  const names = new Set(
    models.flatMap((model) => (model.service_tiers ?? []).map(({ name }) => name.toLowerCase())),
  );
  return [...names].map((name) => ({ name, aliases: [] }));
}

export function codexMethodsIn(source: string): Set<string> {
  type Method = { const?: unknown; enum?: unknown[] };
  const schema = JSON.parse(source) as {
    oneOf?: { properties?: { method?: Method } }[];
  };
  if (!Array.isArray(schema.oneOf) || !schema.oneOf.length)
    throw new Error("no message variants in the Codex schema");
  return new Set(
    schema.oneOf.map(({ properties }) => {
      const method = properties?.method;
      const name = method?.const ?? (method?.enum?.length === 1 ? method.enum[0] : undefined);
      if (typeof name !== "string")
        throw new Error("no method discriminant in a Codex schema variant");
      return name;
    }),
  );
}

const CODEX_MESSAGE_KINDS = ["ClientRequest", "ServerNotification", "ServerRequest"] as const;

function codexMethods(program: string, experimental = false) {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-schema-"));
  try {
    run(program, [
      "app-server",
      "generate-json-schema",
      "--out",
      dir,
      ...(experimental ? ["--experimental"] : []),
    ]);
    return Object.fromEntries(
      CODEX_MESSAGE_KINDS.map((kind) => [
        kind,
        codexMethodsIn(readFileSync(path.join(dir, `${kind}.json`), "utf8")),
      ]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function methodsTheAppUses() {
  const renderer = path.join(ROOT, "src/renderer");
  const source = (file: string) => readFileSync(path.join(renderer, file), "utf8");
  const controller = source("services/chat/codex/controller.ts");
  const callers = [
    controller,
    source("services/chat/codex/run-command.ts"),
    source("components/chat/codex-tab.tsx"),
  ].join("\n");
  const requests = new Set(
    [...callers.matchAll(/\b(?:request|ask)\(\s*"([a-z][\w/]*)"/g)].map((m) => m[1]),
  );
  const read = new Set(
    [...source("services/chat/codex/model.ts").matchAll(/case "([a-z]\w*(?:\/\w+)+)"/g)].map(
      (m) => m[1],
    ),
  );
  read.add(THREAD_STATUS_CHANGED);
  const experimentalOptIn = /capabilities:\s*\{[^}]*\bexperimentalApi:\s*true\b/.test(controller);
  return { requests, read, experimentalOptIn };
}

async function checkCodex(verbose: boolean): Promise<Report> {
  const program = findProgram("codex");
  const version = run(program, ["--version"]).trim().split(/\s+/).pop() ?? "";
  const release = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs`;
  const source = async (file: string) => {
    const url = `${release}/${file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
  };
  const [slashCommands, modelCatalog] = await Promise.all([
    source("tui/src/slash_command.rs"),
    source("models-manager/models.json"),
  ]);
  const cli = codexCommandsIn(slashCommands);
  const builtIns = new Set(cli.flatMap((command) => [command.name, ...command.aliases]));
  cli.push(
    ...codexServiceTierCommandsIn(modelCatalog).filter((command) => !builtIns.has(command.name)),
  );
  const { problems, notes } = accountFor("Codex", cli, {
    fromCli: new Set(),
    app: CODEX_COMMANDS,
    appTable: "CODEX_COMMANDS",
    leftOut: CODEX_LEFT_OUT,
    later: CODEX_LATER,
    appOnly: CODEX_APP_ONLY,
  });

  const publicMethods = codexMethods(program);
  const experimentalMethods = codexMethods(program, true);
  const { requests, read, experimentalOptIn } = methodsTheAppUses();
  const acceptedRequests = new Set([
    ...publicMethods.ClientRequest,
    ...experimentalMethods.ClientRequest,
  ]);
  const known = new Set(
    CODEX_MESSAGE_KINDS.flatMap((kind) => [...publicMethods[kind], ...experimentalMethods[kind]]),
  );
  for (const method of requests) {
    if (!acceptedRequests.has(method)) {
      problems.push(`${method}: the app asks for it, but the app-server no longer takes it`);
    }
  }
  for (const method of read) {
    if (!known.has(method)) {
      problems.push(`${method}: codex-model.ts reads it, but the app-server no longer lists it`);
    }
  }
  const usedExperimental = [...requests].filter(
    (method) =>
      !publicMethods.ClientRequest.has(method) && experimentalMethods.ClientRequest.has(method),
  );
  if (usedExperimental.length && !experimentalOptIn) {
    problems.push(
      `app-server: requests require experimentalApi in initialize: ${usedExperimental.join(" ")}`,
    );
  }
  const unused = [...acceptedRequests].filter((m) => !requests.has(m)).sort();
  notes.push(
    `app-server: the app makes ${requests.size} of its ${acceptedRequests.size} requests (${usedExperimental.length} experimental)` +
      (verbose ? `; the rest: ${unused.join(" ")}` : " (--verbose lists the rest)"),
  );
  return { title: `Codex ${version} (${program})`, problems, notes };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const verbose = args.includes("--verbose");
  const only = args.find((a) => !a.startsWith("--"));
  if (only !== undefined && only !== "claude" && only !== "codex") {
    console.error("usage: bun run check:agent-commands [claude|codex] [--verbose]");
    return 2;
  }
  const checks: [string, () => Report | Promise<Report>][] = [
    ["claude", checkClaude],
    ["codex", () => checkCodex(verbose)],
  ];
  let failed = false;
  if (!only) {
    const help = commandHelp(noteReport);
    if (
      !["note report", "--done", "--failed", "--pr", "--line"].every((part) => help.includes(part))
    ) {
      console.error("nexus note report: missing usage or options");
      failed = true;
    }
  }
  for (const [agent, check] of checks) {
    if (only && only !== agent) continue;
    let report: Report;
    try {
      report = await check();
    } catch (err) {
      console.error(`${agent}: not checked: ${(err as Error).message}\n`);
      failed = true;
      continue;
    }
    console.log(report.title);
    for (const note of report.notes) console.log(`  ${note}`);
    for (const problem of report.problems) console.log(`  ✗ ${problem}`);
    if (report.problems.length === 0) console.log("  ok");
    console.log();
    failed ||= report.problems.length > 0;
  }
  return failed ? 1 : 0;
}

if (import.meta.main) process.exit(await main());
