/**
 * table — columns line up in a terminal when a title is Korean.
 */
import { expect, test } from "bun:test";
import { table } from "../../../../src/main/features/cli/format";

test("a Korean title takes two columns a character", () => {
  expect(
    table(
      ["ID", "TITLE", "STATE"],
      [
        ["a1", "터미널", "busy"],
        ["b2", "zsh", "quiet"],
      ],
    ),
  ).toBe(["ID  TITLE   STATE", "a1  터미널  busy", "b2  zsh     quiet"].join("\n"));
});
