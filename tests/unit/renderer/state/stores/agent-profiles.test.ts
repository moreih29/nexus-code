/**
 * The default profile's folder as Settings and a chat tab show it: the one
 * the agent uses on this machine, which CLAUDE_CONFIG_DIR or CODEX_HOME may
 * move from ~/.claude or ~/.codex.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { defaultFolderLabel } from "../../../../../src/renderer/state/stores/agent-profiles";
import { setPlatformForTests } from "../../../../../src/renderer/utils/platform";

afterEach(() => {
  setPlatformForTests(null);
});

describe("defaultFolderLabel", () => {
  test("~/.claude and ~/.codex until main has told the folders", () => {
    const state = { home: "", defaultDirs: { claude: "", codex: "" } };
    expect(defaultFolderLabel("claude", state)).toBe("~/.claude");
    expect(defaultFolderLabel("codex", state)).toBe("~/.codex");
  });

  test("the folder main tells, in the home as ~/", () => {
    setPlatformForTests("darwin");
    const state = {
      home: "/Users/me",
      defaultDirs: { claude: "/Users/me/.config/claude", codex: "/opt/codex" },
    };
    expect(defaultFolderLabel("claude", state)).toBe("~/.config/claude");
    expect(defaultFolderLabel("codex", state)).toBe("/opt/codex");
  });

  test("on Windows, with the slash every other profile folder shows", () => {
    setPlatformForTests("win32");
    const state = {
      home: String.raw`C:\Users\me`,
      defaultDirs: { claude: String.raw`C:\Users\me\.claude`, codex: String.raw`D:\agents\codex` },
    };
    expect(defaultFolderLabel("claude", state)).toBe("~/.claude");
    expect(defaultFolderLabel("codex", state)).toBe(String.raw`D:\agents\codex`);
  });
});
