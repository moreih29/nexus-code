import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitErrorKindSchema } from "../src/shared/types/git";

export interface GitErrorKindParityOptions {
  readonly tsKinds?: readonly string[];
  readonly goFile?: string;
  readonly fixtureRoot?: string;
}

export interface GitErrorKindParityResult {
  readonly ok: boolean;
  readonly tsKinds: readonly string[];
  readonly goKinds: readonly string[];
  readonly fixtureKinds: readonly string[];
  readonly problems: readonly string[];
}

const DEFAULT_GO_FILE = path.join(process.cwd(), "internal/git/errors.go");
const DEFAULT_FIXTURE_ROOT = path.join(process.cwd(), "tests/fixtures/git/stderr");

/**
 * Checks that TypeScript's GitErrorKindSchema and Go's Kind constants do not drift.
 */
export function checkGitErrorKindParity(
  options: GitErrorKindParityOptions = {},
): GitErrorKindParityResult {
  const tsKinds = sortedUnique(options.tsKinds ?? GitErrorKindSchema.options);
  const goFile = options.goFile ?? DEFAULT_GO_FILE;
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const goKinds = sortedUnique(readGoKindConstants(goFile));
  const fixtureKinds = sortedUnique(readFixtureKinds(fixtureRoot));

  const problems = [
    ...describeSetMismatch({
      expectedLabel: "GitErrorKindSchema",
      actualLabel: "Go Kind constants",
      expected: tsKinds,
      actual: goKinds,
    }),
    ...describeFixtureUnknowns(fixtureKinds, tsKinds, goKinds),
  ];

  return {
    ok: problems.length === 0,
    tsKinds,
    goKinds,
    fixtureKinds,
    problems,
  };
}

/**
 * Parses internal/git/errors.go and returns string values assigned to Kind constants.
 */
export function readGoKindConstants(goFile: string): string[] {
  const source = readFileSync(goFile, "utf8");
  const kinds: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*Kind[A-Za-z0-9_]*\s+(?:Kind\s+)?=\s*"([^"]+)"/);
    if (match) kinds.push(match[1]);
  }
  return kinds;
}

/**
 * Reads expected.json files under tests/fixtures/git/stderr and collects top-level kind values.
 */
export function readFixtureKinds(fixtureRoot: string): string[] {
  if (!existsSync(fixtureRoot)) return [];

  const kinds: string[] = [];
  for (const expectedJson of findExpectedJsonFiles(fixtureRoot)) {
    const parsed = JSON.parse(readFileSync(expectedJson, "utf8")) as { kind?: unknown };
    if (typeof parsed.kind === "string") kinds.push(parsed.kind);
  }
  return kinds;
}

function describeSetMismatch(options: {
  readonly expectedLabel: string;
  readonly actualLabel: string;
  readonly expected: readonly string[];
  readonly actual: readonly string[];
}): string[] {
  const expected = new Set(options.expected);
  const actual = new Set(options.actual);
  const missing = options.expected.filter((kind) => !actual.has(kind));
  const extra = options.actual.filter((kind) => !expected.has(kind));
  const problems: string[] = [];
  if (missing.length > 0) {
    problems.push(
      `${options.actualLabel} missing ${options.expectedLabel} values: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `${options.actualLabel} has extra values absent from ${options.expectedLabel}: ${extra.join(", ")}`,
    );
  }
  return problems;
}

function describeFixtureUnknowns(
  fixtureKinds: readonly string[],
  tsKinds: readonly string[],
  goKinds: readonly string[],
): string[] {
  const ts = new Set(tsKinds);
  const go = new Set(goKinds);
  const notInTs = fixtureKinds.filter((kind) => !ts.has(kind));
  const notInGo = fixtureKinds.filter((kind) => !go.has(kind));
  const problems: string[] = [];
  if (notInTs.length > 0) {
    problems.push(
      `Fixture expected.json kind values absent from GitErrorKindSchema: ${notInTs.join(", ")}`,
    );
  }
  if (notInGo.length > 0) {
    problems.push(
      `Fixture expected.json kind values absent from Go Kind constants: ${notInGo.join(", ")}`,
    );
  }
  return problems;
}

function findExpectedJsonFiles(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) return path.basename(root) === "expected.json" ? [root] : [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findExpectedJsonFiles(child));
    } else if (entry.isFile() && entry.name === "expected.json") {
      files.push(child);
    }
  }
  return files.sort();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function runCli(): void {
  const result = checkGitErrorKindParity();
  if (result.ok) {
    console.log(`Git error kind parity OK (${result.tsKinds.length} kinds).`);
    return;
  }

  console.error("Git error kind parity failed:");
  for (const problem of result.problems) console.error(`- ${problem}`);
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
