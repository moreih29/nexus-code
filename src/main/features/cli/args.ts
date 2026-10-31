/**
 * Splits a nexus command line into positional arguments and flags.
 *
 * `--name value`, `--name=value` and bare `--name` (true) are flags; `-h` is
 * `--help`; `--` ends the flags. Everything else is positional, in order.
 * Which flags take a value is the command's to say, so a bare flag followed
 * by a word is told apart by the spec.
 */

/** How a command reads one flag. */
export interface FlagSpec {
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  /** A short name for the value in help, such as "N" or "URL". */
  readonly value?: string;
}

export type FlagValues = Record<string, string | number | boolean | undefined>;

export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: FlagValues;
}

/** A command line the command cannot take; its message is shown as is. */
export class CliUsageError extends Error {}

/** Flags every command takes. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Print JSON instead of text" },
  help: { type: "boolean", description: "Show help" },
};

/**
 * Parses `argv` against the flags a command takes. An unknown flag, or a
 * missing or malformed value, is a CliUsageError.
 */
export function parseArgs(argv: readonly string[], specs: Record<string, FlagSpec>): ParsedArgs {
  const all = { ...GLOBAL_FLAGS, ...specs };
  const positionals: string[] = [];
  const flags: FlagValues = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] as string;
    i++;
    if (arg === "--") {
      positionals.push(...argv.slice(i));
      break;
    }
    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const spec = all[name];
    if (!spec) throw new CliUsageError(`unknown flag --${name}`);
    let raw: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (spec.type === "boolean") {
      if (raw === undefined) flags[name] = true;
      else if (raw === "true" || raw === "false") flags[name] = raw === "true";
      else throw new CliUsageError(`--${name} takes no value`);
      continue;
    }
    if (raw === undefined) {
      if (i >= argv.length) throw new CliUsageError(`--${name} needs a value`);
      raw = argv[i] as string;
      i++;
    }
    if (spec.type === "number") {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new CliUsageError(`--${name} takes a number, not "${raw}"`);
      }
      flags[name] = value;
    } else {
      flags[name] = raw;
    }
  }
  return { positionals, flags };
}

/**
 * Reads a duration such as "90s", "5m", "1h" or "1500ms"; a bare number is
 * seconds. Returns milliseconds.
 */
export function parseDuration(text: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match)
    throw new CliUsageError(`--${flag} takes a duration such as 30s or 5m, not "${text}"`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * factor);
}
