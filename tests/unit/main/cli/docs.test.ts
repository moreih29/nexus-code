/**
 * docs/CLI.md, the CLI's reference, names every command nexus has, as
 * "nexus tab pin" or, beside its sibling, as "tab unpin": a command added
 * without a word there fails here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
