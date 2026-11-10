/**
 * Compares the slash commands Claude Code and Codex have with what the
 * app's tabs know of them, for when either CLI is upgraded. Run by hand,
 * not in CI: it runs the installed `claude` and `codex`, neither of which
 * calls a model for it, and reads Codex's command list from its source at
 * the installed version's tag on GitHub.
 *
 *   bun run check:agent-commands [claude|codex] [--verbose]
 *
 * Every command a CLI has must be accounted for: the tab gets it from the
 * CLI (Claude Code's headless commands), runs it itself (APP_COMMANDS,
 * CODEX_COMMANDS), or it is listed below as left out, with the reason, or
 * as one to do later. Exits 1 when one is not, when the tab runs one the
 * CLI no longer has, when a command left out as off is on now, or when a
 * /config key or a Codex request the app uses has changed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { APP_COMMANDS, type AppCommand } from "../src/renderer/services/chat/app-commands";
import { CONFIG_KEYS, parseConfigUsage } from "../src/renderer/services/chat/claude-config";
import { CODEX_COMMANDS } from "../src/renderer/services/chat/codex-commands";

/** A command its definition turns off; the check says when it is on again. */
const OFF = "off in its definition";
const TERMINAL = "the terminal's own UI";

/** Claude Code's commands the tab leaves out on purpose, and why. */
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

/** Claude Code's commands the tab could run and does not yet. */
const CLAUDE_LATER: Record<string, string> = {
  restart:
    "restarts the program, keeping the session; the tab offers it only after a failure or a terminal command",
};

/** The Claude tab's commands Claude Code does not have. */
const CLAUDE_APP_ONLY: Record<string, string> = {};

/** Codex's commands the tab leaves out on purpose, and why. */
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
  usage: "the tab's usage line shows it",
  vim: TERMINAL,
  voice: "dictation in the terminal",
  warnings: "for debugging Codex",
  worktree: "the app makes worktrees as tasks of its own",
};

/** Codex's commands the tab could run and does not yet: the request each would use. */
const CODEX_LATER: Record<string, string> = {
  apps: "app/list",
  archive: "thread/archive",
  btw: "an ephemeral thread/fork",
  delete: "thread/delete",
  experimental: "experimentalFeature/list, experimentalFeature/enablement/set",
  hooks: "hooks/list",
  memories: "config/value/write",
  plan: "a collaboration mode on turn/start",
  plugins: "plugin/list",
  recap: "a turn of its own",
  side: "an ephemeral thread/fork",
};

/** The Codex tab's commands Codex does not have. */
const CODEX_APP_ONLY: Record<string, string> = {
  effort: "Codex's /model picks it; the tab has a chip for each",
  help: "lists the tab's commands",
};

const ROOT = path.join(import.meta.dir, "..");

interface CliCommand {
  name: string;
  aliases: string[];
  /** Its definition turns it off (`isEnabled: () => false`). */
  off?: boolean;
}

interface Report {
  title: string;
  problems: string[];
  notes: string[];
}

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/** The first `name` on PATH that is a program, not a script wrapping it (as the app's own is). */
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

/**
 * What every command the CLI has, and every one the tables name, comes to:
 * the problems with them, and what the tables say of the rest.
 */
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

// ── Claude Code ─────────────────────────────────────────────────────────

const COMMAND_TYPE = 'type:"(?:local-jsx|local|prompt)"';
const NAME = 'name:"([a-z][a-z0-9-]*)"';

/**
 * The built-in commands in Claude Code's program: the objects its bundle
 * defines them with, `{type:"local-jsx",name:"…",aliases:[…],…}`, the type
 * before the name or after it (a description's getter may come between).
 */
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
      // The rest of its object: up to the next command, object or statement.
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

/** What a headless run has: its commands (system/init) and a bare /config's answer. */
function claudeHeadless(program: string): { commands: string[]; configUsage: string } {
  // Run by Claude Code alone, as the app's own /config list is: no model,
  // no session kept, none of the user's hooks.
  const stdout = run(program, [
    "-p",
    "--no-session-persistence",
    "--settings",
    '{"disableAllHooks":true}',
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

function checkClaude(): Report {
  const program = findProgram("claude");
  const version = run(program, ["--version"]).trim().split(/\s+/)[0];
  const cli = claudeCommandsIn(readFileSync(program).toString("latin1"));
  const headless = claudeHeadless(program);
  const { problems, notes } = accountFor("Claude Code", cli, {
    fromCli: new Set(headless.commands),
    app: APP_COMMANDS,
    appTable: "APP_COMMANDS",
    leftOut: CLAUDE_LEFT_OUT,
    later: CLAUDE_LATER,
    appOnly: CLAUDE_APP_ONLY,
  });

  // The settings dialog shows every key a bare /config lists; the table
  // says where each one's value is read.
  const listed = parseConfigUsage(headless.configUsage);
  if (listed.length === 0) {
    problems.push("/config: no keys in a bare /config's answer");
  } else {
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
      if (!listedKeys.has(key))
        problems.push(`/config ${key}: Claude Code no longer lists it (CONFIG_KEYS)`);
    }
  }
  notes.push(`/config: ${listed.length} keys, the table ${CONFIG_KEYS.length}`);
  return { title: `Claude Code ${version} (${program})`, problems, notes };
}

// ── Codex ───────────────────────────────────────────────────────────────

function kebab(variant: string): string {
  return variant.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The commands of Codex's TUI, from its `SlashCommand` enum
 * (codex-rs/tui/src/slash_command.rs): each variant kebab-cased, unless
 * strum names it (`to_string` the name, `serialize` the others).
 */
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

/** The methods of each message kind in the app-server's JSON schema. */
function codexMethods(program: string): Record<string, Set<string>> {
  const dir = mkdtempSync(path.join(tmpdir(), "codex-schema-"));
  try {
    run(program, ["app-server", "generate-json-schema", "--out", dir]);
    const methods: Record<string, Set<string>> = {};
    for (const kind of ["ClientRequest", "ServerNotification", "ServerRequest"]) {
      const schema = readFileSync(path.join(dir, `${kind}.json`), "utf8");
      methods[kind] = new Set(
        [...schema.matchAll(/"method":\s*\{[^}]*?"enum":\s*\[\s*"([^"]+)"/g)].map((m) => m[1]),
      );
    }
    return methods;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The requests the app's Codex code makes, and the methods its model reads. */
function methodsTheAppUses(): { requests: Set<string>; read: Set<string> } {
  const dir = path.join(ROOT, "src/renderer/services/chat");
  const source = (file: string) => readFileSync(path.join(dir, file), "utf8");
  const callers = ["codex-controller.ts", "run-codex-command.ts"].map(source).join("\n");
  const requests = new Set(
    [...callers.matchAll(/\b(?:request|ask)\(\s*"([a-z][\w/]*)"/g)].map((m) => m[1]),
  );
  const read = new Set(
    [...source("codex-model.ts").matchAll(/case "([a-z]\w*(?:\/\w+)+)"/g)].map((m) => m[1]),
  );
  return { requests, read };
}

async function checkCodex(verbose: boolean): Promise<Report> {
  const program = findProgram("codex");
  const version = run(program, ["--version"]).trim().split(/\s+/).pop() ?? "";
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/tui/src/slash_command.rs`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const cli = codexCommandsIn(await response.text());
  const { problems, notes } = accountFor("Codex", cli, {
    fromCli: new Set(),
    app: CODEX_COMMANDS,
    appTable: "CODEX_COMMANDS",
    leftOut: CODEX_LEFT_OUT,
    later: CODEX_LATER,
    appOnly: CODEX_APP_ONLY,
  });

  const methods = codexMethods(program);
  const { requests, read } = methodsTheAppUses();
  for (const method of requests) {
    if (!methods.ClientRequest.has(method)) {
      problems.push(`${method}: the app asks for it, but the app-server no longer takes it`);
    }
  }
  const known = new Set([
    ...methods.ClientRequest,
    ...methods.ServerNotification,
    ...methods.ServerRequest,
  ]);
  for (const method of read) {
    if (!known.has(method)) {
      problems.push(`${method}: codex-model.ts reads it, but the app-server no longer sends it`);
    }
  }
  const unused = [...methods.ClientRequest].filter((m) => !requests.has(m)).sort();
  notes.push(
    `app-server: the app makes ${requests.size} of its ${methods.ClientRequest.size} requests` +
      (verbose ? `; the rest: ${unused.join(" ")}` : " (--verbose lists the rest)"),
  );
  return { title: `Codex ${version} (${program})`, problems, notes };
}

// ── Main ────────────────────────────────────────────────────────────────

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
