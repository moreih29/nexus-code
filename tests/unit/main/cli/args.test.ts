/**
 * parseArgs and parseDuration — the command line as a command reads it.
 */
import { expect, test } from "bun:test";
import { CliUsageError, parseArgs, parseDuration } from "../../../../src/main/features/cli/args";

const SPECS = {
  lines: { type: "number", description: "" },
  workspace: { type: "string", description: "" },
  enter: { type: "boolean", description: "" },
} as const;

test.each([
  [
    "flags around positionals",
    ["abc", "--lines", "5", "hello", "world"],
    ["abc", "hello", "world"],
    { lines: 5 },
  ],
  ["= values and -h", ["--workspace=api", "-h"], [], { workspace: "api", help: true }],
  ["a boolean set false", ["--enter=false", "x"], ["x"], { enter: false }],
  ["-- ends the flags", ["send", "--", "--lines", "-h"], ["send", "--lines", "-h"], {}],
  ["a lone - is a positional", ["t1", "-"], ["t1", "-"], {}],
])("%s", (_label, argv, positionals, flags) => {
  expect(parseArgs(argv, SPECS)).toEqual({ positionals, flags });
});

test.each([
  [["--nope"], "unknown flag --nope"],
  [["--enter=yes"], "--enter takes no value"],
  [["--lines", ""], '--lines takes a number, not ""'],
])("%j is refused", (argv, message) => {
  expect(() => parseArgs(argv, SPECS)).toThrow(new CliUsageError(message));
});

test.each([
  ["90", 90_000],
  ["1500ms", 1_500],
  ["2.5m", 150_000],
  ["1h", 3_600_000],
])("duration %s", (text, ms) => {
  expect(parseDuration(text, "timeout")).toBe(ms);
});

test("a duration without a number is refused", () => {
  expect(() => parseDuration("soon", "timeout")).toThrow(CliUsageError);
});
