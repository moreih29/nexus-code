/** The app's commands another computer's chat runs on this one. */
import { describe, expect, test } from "bun:test";
import type { ChatCommand } from "../../../../../packages/remote-protocol/src";
import {
  hereCommandOf,
  hereCommandsOf,
  hereLinkOf,
  inTerminalLineOf,
} from "../../../../../src/renderer/services/remote/here-commands";

const btw: ChatCommand = { name: "btw", description: "Aside", runs: "command" };

describe("commands run here for another computer's chat", () => {
  test("a Claude chat's: /copy, /diff, /help, /exit and the pages, in its tab's order", () => {
    expect(hereCommandsOf("claude", [btw]).map((c) => c.name)).toEqual([
      "copy",
      "diff",
      "upgrade",
      "release-notes",
      "feedback",
      "privacy-settings",
      "help",
      "exit",
    ]);
    expect(hereCommandsOf("codex", []).map((c) => c.name)).toEqual([
      "status",
      "diff",
      "copy",
      "help",
      "exit",
    ]);
    expect(hereCommandOf("codex", [], "/quit")).toEqual({ name: "exit", args: "" });
  });

  test("a Codex chat's /status is its computer's where it lists it (0.13.0), else this app's", () => {
    const status: ChatCommand = { name: "status", description: "", runs: "command" };
    expect(hereCommandOf("codex", [status], "/status")).toBeNull();
    expect(hereCommandOf("codex", [], "/status")).toEqual({ name: "status", args: "" });
  });

  test("one the chat lists by the same name is the chat's", () => {
    const own: ChatCommand = { name: "copy", description: "CLI's", runs: "send" };
    expect(hereCommandsOf("claude", [own]).some((c) => c.name === "copy")).toBe(false);
    expect(hereCommandOf("claude", [own], "/copy")).toBeNull();
  });

  test("a typed one, with what follows it; another is not", () => {
    expect(hereCommandOf("claude", [btw], "/copy 2")).toEqual({ name: "copy", args: "2" });
    expect(hereCommandOf("claude", [btw], " /HELP ")).toEqual({ name: "help", args: "" });
    expect(hereCommandOf("claude", [btw], "/btw why")).toBeNull();
    expect(hereCommandOf("claude", [btw], "copy")).toBeNull();
    expect(hereLinkOf("feedback")).toStartWith("https://");
    expect(hereLinkOf("copy")).toBeUndefined();
  });
});

describe("Claude's commands that run in a terminal, from another computer", () => {
  test("are listed and run only where that computer's terminals can be typed into", () => {
    const names = (terminal: boolean) => hereCommandsOf("claude", [], terminal).map((c) => c.name);
    expect(names(false)).not.toContain("login");
    expect(names(true)).toEqual(
      expect.arrayContaining(["login", "logout", "update", "ultrareview"]),
    );
    expect(hereCommandOf("claude", [], "/login", false)).toBeNull();
    expect(hereCommandOf("claude", [], "/ultrareview 12", true)).toEqual({
      name: "ultrareview",
      args: "12",
    });
    // A Codex chat has none.
    expect(hereCommandsOf("codex", [], true).some((c) => c.name === "login")).toBe(false);
  });

  test("type the line a terminal here runs, its argument one word in any shell there", () => {
    expect(inTerminalLineOf("login", "")).toBe("claude auth login");
    expect(inTerminalLineOf("ultrareview", "")).toBe("claude /ultrareview");
    expect(inTerminalLineOf("ultrareview", "12")).toBe('claude "/ultrareview 12"');
    // What a shell there would expand does not go.
    expect(inTerminalLineOf("ultraplan", "fix $HOME")).toBeNull();
    expect(inTerminalLineOf("ultraplan", 'say "hi"')).toBeNull();
    expect(inTerminalLineOf("ultraplan", "a & b")).toBeNull();
    expect(inTerminalLineOf("copy", "")).toBeNull();
  });
});
