/** The app's commands another computer's chat runs on this one. */
import { describe, expect, test } from "bun:test";
import type { ChatCommand } from "../../../../../packages/remote-protocol/src";
import {
  hereCommandOf,
  hereCommandsOf,
  hereLinkOf,
} from "../../../../../src/renderer/services/remote/here-commands";

const btw: ChatCommand = { name: "btw", description: "Aside", runs: "command" };

describe("commands run here for another computer's chat", () => {
  test("a Claude chat's: /copy, /diff, /help and the pages, in its tab's order", () => {
    expect(hereCommandsOf("claude", [btw]).map((c) => c.name)).toEqual([
      "copy",
      "diff",
      "upgrade",
      "release-notes",
      "feedback",
      "privacy-settings",
      "help",
    ]);
    expect(hereCommandsOf("codex", []).map((c) => c.name)).toEqual(["diff", "copy", "help"]);
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
