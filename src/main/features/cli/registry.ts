/**
 * The nexus command table and the runner that turns one invocation into
 * its output: it finds the command, parses its flags, runs it, and prints
 * text or, with --json, JSON.
 */
import type { CliFile, CliResult } from "../../../shared/cli/protocol";
import { createLogger } from "../../../shared/log/main";
import { CliUsageError, type FlagSpec, GLOBAL_FLAGS, type ParsedArgs, parseArgs } from "./args";
import { type CliContext, CliError } from "./context";

const log = createLogger("cli");

/** What a command gives back: text for people, a value for --json. */
export interface CliOutput {
  readonly text: string;
  readonly json: unknown;
  readonly files?: readonly CliFile[];
  readonly exitCode?: number;
}

export interface CliCommand {
  /** The words that name it, such as ["terminal", "read"]. */
  readonly path: readonly string[];
  readonly summary: string;
  /** Its positional arguments as help shows them, such as "<tab>". */
  readonly args?: string;
  readonly flags?: Record<string, FlagSpec>;
  /** More help, shown under the usage line. */
  readonly details?: string;
  /** Left out of the overview: run by the app's own hooks, not by people. */
  readonly hidden?: boolean;
  run(ctx: CliContext, input: ParsedArgs): Promise<CliOutput>;
}

/** A helper for commands with nothing to say but a value. */
export function output(text: string, json: unknown, extra: Partial<CliOutput> = {}): CliOutput {
  return { text, json, ...extra };
}

function usageLine(command: CliCommand): string {
  return [
    "nexus",
    ...command.path,
    command.args ?? "",
    Object.keys(command.flags ?? {}).length ? "[flags]" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function flagLines(flags: Record<string, FlagSpec>): string[] {
  const rows = Object.entries(flags).map(([name, spec]) => {
    const value = spec.type === "boolean" ? "" : ` ${spec.value ?? spec.type.toUpperCase()}`;
    return [`--${name}${value}`, spec.description] as const;
  });
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
}

export function commandHelp(command: CliCommand): string {
  const lines = [`usage: ${usageLine(command)}`, "", command.summary];
  if (command.details) lines.push("", command.details);
  const flags = command.flags ?? {};
  if (Object.keys(flags).length > 0) lines.push("", "flags:", ...flagLines(flags));
  lines.push("", "global flags:", ...flagLines(GLOBAL_FLAGS));
  return `${lines.join("\n")}\n`;
}

/** The overview `nexus help` prints, optionally for one group of commands. */
export function overviewHelp(commands: readonly CliCommand[], group?: string): string {
  const listed = commands.filter((c) => !c.hidden);
  const shown = group ? listed.filter((c) => c.path[0] === group) : listed;
  const names = shown.map((c) => [c.path.join(" "), c.args ?? ""].filter(Boolean).join(" "));
  const width = Math.max(0, ...names.map((n) => n.length));
  const lines = [
    "nexus drives NexusCode from its terminals: workspaces, terminals, editors and the browser.",
    "",
    "usage: nexus <command> [args] [--json]",
    "",
    "commands:",
    ...shown.map((c, i) => `  ${(names[i] as string).padEnd(width)}  ${c.summary}`),
    "",
    'Run "nexus <command> --help" for a command\'s flags. Ids may be shortened to any unique prefix;',
    'a workspace or tab may also be named by its name or title. "." is the current one.',
  ];
  return `${lines.join("\n")}\n`;
}

/** The command `argv` names: the one whose whole path its first words match. */
function findCommand(
  commands: readonly CliCommand[],
  argv: readonly string[],
): { command: CliCommand; rest: string[] } | null {
  let best: CliCommand | null = null;
  for (const command of commands) {
    if (command.path.every((word, i) => argv[i] === word)) {
      if (!best || command.path.length > best.path.length) best = command;
    }
  }
  return best ? { command: best, rest: argv.slice(best.path.length) } : null;
}

function result(stdout: string, stderr = "", exitCode = 0, files?: readonly CliFile[]): CliResult {
  return { stdout, stderr, exitCode, ...(files && files.length > 0 ? { files } : {}) };
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

/** Runs one invocation of the nexus command. Never throws. */
export async function runCli(commands: readonly CliCommand[], ctx: CliContext): Promise<CliResult> {
  const argv = ctx.invocation.argv;
  const first = argv[0];
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    const topic = first === "help" ? argv.slice(1) : [];
    const found = topic.length > 0 ? findCommand(commands, topic) : null;
    if (found) return result(commandHelp(found.command));
    return result(overviewHelp(commands, topic[0]));
  }
  if (first === "--version" || first === "version") return result(`${ctx.services.appVersion}\n`);

  const found = findCommand(commands, argv);
  if (!found) {
    if (commands.some((c) => c.path[0] === first)) {
      const wantsHelp = argv.includes("--help") || argv.includes("-h");
      return result(overviewHelp(commands, first), "", wantsHelp ? 0 : 2);
    }
    return result("", `nexus: unknown command "${first}". Run "nexus help".\n`, 2);
  }

  const { command, rest } = found;
  try {
    const parsed = parseArgs(rest, command.flags ?? {});
    if (parsed.flags.help === true) return result(commandHelp(command));
    const out = await command.run(ctx, parsed);
    const stdout =
      parsed.flags.json === true ? `${JSON.stringify(out.json, null, 2)}\n` : withNewline(out.text);
    return result(stdout, "", out.exitCode ?? 0, out.files);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return result("", `nexus: ${error.message}\nusage: ${usageLine(command)}\n`, 2);
    }
    if (error instanceof CliError) return result("", `nexus: ${error.message}\n`, error.exitCode);
    log.warn(`nexus ${command.path.join(" ")} failed: ${(error as Error).message}`);
    return result("", `nexus: ${(error as Error).message}\n`, 1);
  }
}
