/**
 * A tab's rename box starts from the tab's name when editing starts and then
 * holds what is typed, even when a terminal's title changes meanwhile.
 */
import { describe, expect, test } from "bun:test";
import {
  followRenameDraft,
  type RenameDraft,
} from "../../../../../../src/renderer/components/workspace/tabs/rename-draft";

const idle: RenameDraft = { editing: false, value: "zsh" };

describe("a tab's rename box", () => {
  test("starts from the tab's name when editing starts", () => {
    expect(followRenameDraft(idle, true, "npm run dev")).toEqual({
      editing: true,
      value: "npm run dev",
    });
  });

  test("keeps what is typed when the terminal's title changes mid-edit", () => {
    const typed: RenameDraft = { editing: true, value: "my serv" };
    // A shell sets the title per command (OSC 0/2) while the user types.
    expect(followRenameDraft(typed, true, "vim server.ts")).toBe(typed);
    expect(followRenameDraft(typed, true, "zsh")).toBe(typed);
  });

  test("an edit begun again starts from the name then, not the earlier text", () => {
    const ended = followRenameDraft({ editing: true, value: "old text" }, false, "zsh");
    expect(ended.editing).toBe(false);
    expect(followRenameDraft(ended, true, "build")).toEqual({ editing: true, value: "build" });
  });

  test("outside editing, a title change sets nothing", () => {
    expect(followRenameDraft(idle, false, "top")).toBe(idle);
  });
});
