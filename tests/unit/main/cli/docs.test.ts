/**
 * docs/CLI.md, the CLI's reference, names every command nexus has, as
 * "nexus tab pin" or, beside its sibling, as "tab unpin": a command added
 * without a word there fails here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../../../../src/main/features/cli/args";
import { CLI_COMMANDS } from "../../../../src/main/features/cli/commands";

const doc = readFileSync(join(import.meta.dir, "../../../../docs/CLI.md"), "utf8");

test("docs/CLI.md names every nexus command", () => {
  const named = (path: string) =>
    new RegExp(`(^|[\\s\`(])${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s\`)])`, "m").test(
      doc,
    );
  // Hidden commands are for hooks and wrappers, not people or agents.
  const missing = CLI_COMMANDS.filter((command) => !command.hidden)
    .map((command) => command.path.join(" "))
    .filter((path) => !named(path));
  expect(missing).toEqual([]);
});

test.each([
  "chat command TAB remote-control",
  "chat rewind 3fa2 12 --preview",
  "chat profiles --agent codex --workspace WS --json",
  "view layout --json",
  "view open-file README.md --panel 1",
  "view split right --key KEY",
  "note transcript NOTE --recording RECORDING --json",
  "note record NOTE --participants 3",
  "settings instructions show --workspace WS --agent codex --json",
])("docs example uses registered syntax for %s", (example) => {
  expect(doc).toContain(example);
  const argv = example.split(" ");
  const command = CLI_COMMANDS.filter((entry) =>
    entry.path.every((word, index) => argv[index] === word),
  ).sort((a, b) => b.path.length - a.path.length)[0];
  expect(command).toBeDefined();
  if (!command) return;
  expect(() => parseArgs(argv.slice(command.path.length), command.flags ?? {})).not.toThrow();
});
