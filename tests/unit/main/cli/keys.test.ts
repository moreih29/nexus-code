/** The bytes `nexus terminal key` sends for each key name. */
import { expect, test } from "bun:test";
import { CliUsageError } from "../../../../src/main/features/cli/args";
import { keySequence } from "../../../../src/main/features/cli/keys";

test.each([
  ["enter", "\r"],
  ["Esc", "\x1b"],
  ["shift-tab", "\x1b[Z"],
  ["up", "\x1b[A"],
  ["ctrl-c", "\x03"],
  ["Ctrl+D", "\x04"],
  ["ctrl-z", "\x1a"],
  ["y", "y"],
  ["한", "한"],
])("%s", (name, bytes) => {
  expect(keySequence(name)).toBe(bytes);
});

test("a word that is not a key is refused", () => {
  expect(() => keySequence("hello")).toThrow(CliUsageError);
});
