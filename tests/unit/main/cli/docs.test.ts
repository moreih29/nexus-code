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
import { commandHelp } from "../../../../src/main/features/cli/registry";

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
  "chat profiles add --agent codex --name Personal",
  "chat profiles add --agent claude --name Gateway --base-url https://llm.example.com --model glm --model kimi --default-model glm --light-model kimi --key-file - --instructions-file rules.md --json",
  "view layout --json",
  "view open-file README.md --panel 1",
  "view split right --key KEY",
  "note transcript NOTE --recording RECORDING --json",
  "note record NOTE --participants 3",
  "settings instructions show --workspace WS --agent codex --json",
  'settings instructions show --device "Mac mini" --workspace WS --agent codex --json',
  "settings instructions show --workspace WS --profile Work --json",
  'chat instructions 1a2b --show --device "Mac mini"',
  'chat instructions 1a2b --set-file rules.md --device "Mac mini"',
  'chat instructions 1a2b --clear --device "Mac mini"',
  "chat read 3fa2 --answer 12",
  "chat export 3fa2 --stdout",
  "chat image 3fa2 --message 12 --out attachment.png",
  "note speaker merge meeting voice-2 voice-1 --recording REC",
  "note speaker regroup meeting --participants 3 --recording REC",
  "note voice suggestions list meeting --recording REC",
  "note voice delete Alex",
  "settings instructions set workspace --workspace WS --clear",
  "settings instructions set profile --profile Work --file -",
  'settings instructions set profile --profile codex-default --device "Mac mini" --clear',
  "settings keys list --json",
  "settings lsp status --json",
  "settings updates status --json",
  "terminal reopen 3fa2",
  "layout focus 2",
  "tab close index.ts --right",
  "tab encoding index.ts --json",
  "events --device all --json",
  "browser permissions --workspace site --device Mini --json",
])("docs example uses registered syntax for %s", (example) => {
  expect(doc).toContain(example);
  const argv = example.match(/"[^"]*"|\S+/g)?.map((word) => word.replace(/^"|"$/g, "")) ?? [];
  const command = CLI_COMMANDS.filter((entry) =>
    entry.path.every((word, index) => argv[index] === word),
  ).sort((a, b) => b.path.length - a.path.length)[0];
  expect(command).toBeDefined();
  if (!command) return;
  expect(() => parseArgs(argv.slice(command.path.length), command.flags ?? {})).not.toThrow();
});

test("chat instructions help includes all three actions for a peer device", () => {
  const command = CLI_COMMANDS.find(({ path }) => path.join(" ") === "chat instructions");
  expect(command).toBeDefined();
  if (!command) return;
  expect(commandHelp(command)).toContain(
    "Use exactly one of --show, --set-file FILE, or --clear. All three work with --device.",
  );
});
