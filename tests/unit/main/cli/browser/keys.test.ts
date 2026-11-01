/** Keys for nexus browser press, read into CDP key events. */
import { expect, test } from "bun:test";
import { parseBrowserKey } from "../../../../../src/main/features/cli/browser/keys";
import { CliError } from "../../../../../src/main/features/cli/context";

test("named keys type what they type, and only those", () => {
  expect(parseBrowserKey("Enter", false)).toEqual({
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    modifiers: 0,
    text: "\r",
  });
  expect(parseBrowserKey("tab", false)).toEqual({
    key: "Tab",
    code: "Tab",
    keyCode: 9,
    modifiers: 0,
  });
  expect(parseBrowserKey("Down", false).key).toBe("ArrowDown");
  expect(parseBrowserKey("f5", false)).toMatchObject({ key: "F5", keyCode: 116 });
});

test("characters type themselves; shift makes a letter capital", () => {
  expect(parseBrowserKey("a", false)).toEqual({
    key: "a",
    code: "KeyA",
    keyCode: 65,
    modifiers: 0,
    text: "a",
  });
  expect(parseBrowserKey("shift-a", false)).toMatchObject({ key: "A", text: "A", modifiers: 8 });
  expect(parseBrowserKey("-", false)).toMatchObject({ key: "-", text: "-" });
  expect(parseBrowserKey("shift-Tab", false)).toMatchObject({ key: "Tab", modifiers: 8 });
});

test("a shortcut types nothing, and on macOS runs its editing command", () => {
  expect(parseBrowserKey("ctrl-a", false)).toEqual({
    key: "a",
    code: "KeyA",
    keyCode: 65,
    modifiers: 2,
  });
  expect(parseBrowserKey("cmd+a", true)).toMatchObject({ modifiers: 4, commands: ["selectAll"] });
  expect(parseBrowserKey("meta-shift-z", true)).toMatchObject({
    modifiers: 12,
    commands: ["redo"],
  });
  expect(parseBrowserKey("meta-a", false).commands).toBeUndefined();
});

test("an unknown key is a usage error", () => {
  expect(() => parseBrowserKey("hyper-q", false)).toThrow(CliError);
  expect(() => parseBrowserKey("Enterr", false)).toThrow(/unknown key "Enterr"/);
});
