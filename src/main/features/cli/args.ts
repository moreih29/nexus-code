export interface FlagSpec {
  readonly type: "string" | "number" | "boolean";
  readonly description: string;
  readonly value?: string;
  readonly short?: string;
  readonly repeat?: boolean;
}

export type FlagValues = Record<string, string | string[] | number | boolean | undefined>;

export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: FlagValues;
}

export class CliUsageError extends Error {}

export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  json: { type: "boolean", description: "Print JSON instead of text" },
  jsonl: {
    type: "boolean",
    description: "Print JSON Lines: a record a line (the items of a list), for grep and jq",
  },
  help: { type: "boolean", description: "Show help" },
};

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
    const short =
      arg.length === 2 && arg.startsWith("-")
        ? Object.keys(specs).find((name) => specs[name]?.short === arg[1])
        : undefined;
    if (!arg.startsWith("--") && short === undefined) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = short ?? (eq === -1 ? arg.slice(2) : arg.slice(2, eq));
    const spec = Object.hasOwn(all, name) ? all[name] : undefined;
    if (!spec && name === "device") {
      throw new CliUsageError(
        "--device is not taken here: this command acts on this computer only",
      );
    }
    if (!spec) throw new CliUsageError(`unknown flag --${name}`);
    let raw: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
    if (spec.type === "boolean") {
      if (raw === undefined) flags[name] = true;
      else if (raw === "true" || raw === "false") flags[name] = raw === "true";
      else throw new CliUsageError(`--${name} takes no value`);
      continue;
    }
    if (raw === undefined) {
      if (i >= argv.length || (argv[i] as string).startsWith("--")) {
        const hint =
          spec.type === "number"
            ? " (a number alone: a shell drops a # and what follows)"
            : ` (an empty one: --${name}=, which every shell passes)`;
        throw new CliUsageError(`--${name} needs a value${hint}`);
      }
      raw = argv[i] as string;
      i++;
    }
    if (spec.type === "number") {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        throw new CliUsageError(`--${name} takes a number, not "${raw}"`);
      }
      flags[name] = value;
    } else if (spec.repeat) {
      const given = flags[name];
      flags[name] = Array.isArray(given) ? [...given, raw] : [raw];
    } else {
      flags[name] = raw;
    }
  }
  return { positionals, flags };
}

export function parseDuration(text: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match)
    throw new CliUsageError(`--${flag} takes a duration such as 30s or 5m, not "${text}"`);
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * factor);
}

export function exactArgs(positionals: readonly string[], ...names: string[]): string[] {
  if (positionals.length < names.length) {
    throw new CliUsageError(`missing <${names[positionals.length]}>`);
  }
  if (positionals.length > names.length) {
    throw new CliUsageError(`unexpected argument "${positionals[names.length]}"`);
  }
  return [...positionals];
}
