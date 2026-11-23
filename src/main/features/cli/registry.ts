import type { CliFile, CliResult } from "../../../shared/cli/protocol";
import { createLogger } from "../../../shared/log/main";
import { redactLogSecrets } from "../../../shared/log/redact-secrets";
import { CliUsageError, type FlagSpec, GLOBAL_FLAGS, type ParsedArgs, parseArgs } from "./args";
import { type CliContext, CliError } from "./context";

const log = createLogger("cli");

export interface CliOutput {
  readonly text: string;
  readonly json: unknown;
  readonly utf8Json?: true;
  readonly records?: readonly unknown[];
  readonly files?: readonly CliFile[];
  readonly exitCode?: number;
}

export interface CliCommand {
  readonly path: readonly string[];
  readonly summary: string;
  readonly args?: string;
  readonly flags?: Record<string, FlagSpec>;
  readonly details?: string;
  readonly hidden?: boolean;
  run(ctx: CliContext, input: ParsedArgs): Promise<CliOutput>;
}

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
    const short = spec.short ? `-${spec.short}, ` : "";
    return [`${short}--${name}${value}`, spec.description] as const;
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

export function overviewHelp(commands: readonly CliCommand[], group?: string): string {
  const listed = commands.filter((c) => !c.hidden);
  const shown = group ? listed.filter((c) => c.path[0] === group) : listed;
  const names = shown.map((c) => [c.path.join(" "), c.args ?? ""].filter(Boolean).join(" "));
  const width = Math.max(0, ...names.map((n) => n.length));
  const lines = [
    "nexus drives NexusCode from its terminals: workspaces, terminals, editors and the browser.",
    "",
    "usage: nexus <command> [args] [--json | --jsonl]",
    "",
    "commands:",
    ...shown.map((c, i) => `  ${(names[i] as string).padEnd(width)}  ${c.summary}`),
    "",
    'Run "nexus <command> --help" for a command\'s flags. Ids may be shortened to any unique prefix;',
    'a workspace or tab may also be named by its name or title. "." is the current one.',
  ];
  return `${lines.join("\n")}\n`;
}

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

export function commandName(commands: readonly CliCommand[], argv: readonly string[]): string {
  const found = findCommand(commands, argv);
  return found ? found.command.path.join(" ") : "unknown";
}

export function commandWaits(commands: readonly CliCommand[], argv: readonly string[]): boolean {
  const found = findCommand(commands, argv);
  if (!found) return false;
  const last = found.command.path[found.command.path.length - 1];
  return last === "wait" || argv.includes("--wait") || argv.includes("--follow");
}

function result(stdout: string, stderr = "", exitCode = 0, files?: readonly CliFile[]): CliResult {
  return { stdout, stderr, exitCode, ...(files && files.length > 0 ? { files } : {}) };
}

function asciiJson(value: unknown, indent?: number): string {
  return (JSON.stringify(value, null, indent) ?? "null").replace(
    /[\u0080-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function jsonLines(out: CliOutput): string {
  const records = out.records ?? (Array.isArray(out.json) ? out.json : [out.json]);
  return records.map((record) => `${asciiJson(record)}\n`).join("");
}

function withNewline(text: string): string {
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
}

function stdoutOf(out: CliOutput, flags: ParsedArgs["flags"]): string {
  if (flags.jsonl === true) return jsonLines(out);
  if (flags.json === true) {
    return `${out.utf8Json ? JSON.stringify(out.json, null, 2) : asciiJson(out.json, 2)}\n`;
  }
  return withNewline(out.text);
}

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
  let parsed: ParsedArgs | undefined;
  try {
    parsed = parseArgs(rest, command.flags ?? {});
    if (parsed.flags.help === true) return result(commandHelp(command));
    const out = await command.run(ctx, parsed);
    return result(stdoutOf(out, parsed.flags), "", out.exitCode ?? 0, out.files);
  } catch (error) {
    if (error instanceof CliUsageError) {
      return result("", `nexus: ${error.message}\nusage: ${usageLine(command)}\n`, 2);
    }
    if (error instanceof CliError) {
      const stdout =
        parsed && error.json !== undefined
          ? stdoutOf(output("", error.json, { records: [error.json] }), parsed.flags)
          : "";
      return result(stdout, `nexus: ${error.message}\n`, error.exitCode);
    }
    log.warn(
      `nexus ${command.path.join(" ")} failed: ${redactLogSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return result("", `nexus: ${(error as Error).message}\n`, 1);
  }
}
