/**
 * What `nexus chat set` and `chat new --model/--effort/--mode` read of a tab
 * and ask of it: the names its program takes, what it refuses, and only
 * what changes.
 */
import { describe, expect, it } from "bun:test";
import { type ChatModel, emptyModel } from "../../../../../src/renderer/services/chat/model";
import {
  chatChoicesOf,
  planChatSettings,
} from "../../../../../src/renderer/services/cli/chat-settings";
import { loosens } from "../../../../../src/shared/sessions/chat-modes";

function claude(patch: Partial<ChatModel> = {}): ChatModel {
  return {
    ...emptyModel(),
    process: "running",
    init: {
      commands: [],
      remoteControl: false,
      models: [
        {
          value: "default",
          displayName: "Default (recommended)",
          resolvedModel: "claude-opus-5-5",
          supportedEffortLevels: ["low", "medium", "high"],
        },
        { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-5-5" },
        {
          value: "sonnet",
          displayName: "Sonnet",
          resolvedModel: "claude-sonnet-5-5",
          supportedEffortLevels: ["low", "high"],
        },
      ],
    },
    ...patch,
  };
}

describe("planChatSettings", () => {
  it("takes a model by its value, its name or the model it runs, in any case", () => {
    expect(planChatSettings("claude", claude(), { model: "Sonnet" }, true)).toEqual({
      model: "sonnet",
    });
    expect(planChatSettings("claude", claude(), { model: "claude-haiku-5-5" }, true)).toEqual({
      model: "haiku",
    });
  });

  it("asks nothing of what the tab runs with already", () => {
    const model = claude({ model: "claude-sonnet-5-5", effort: "low", permissionMode: "plan" });
    expect(
      planChatSettings("claude", model, { model: "sonnet", effort: "low", mode: "plan" }, true),
    ).toEqual({});
  });

  it("checks the effort against the model it sets", () => {
    expect(planChatSettings("claude", claude(), { model: "sonnet", effort: "HIGH" }, true)).toEqual(
      { model: "sonnet", effort: "high" },
    );
    expect(() =>
      planChatSettings("claude", claude(), { model: "sonnet", effort: "medium" }, true),
    ).toThrow('Sonnet takes no effort "medium"; it takes low, high');
    expect(() =>
      planChatSettings("claude", claude(), { model: "haiku", effort: "low" }, true),
    ).toThrow("Haiku takes no effort level");
  });

  it("refuses an effort an old Claude Code cannot set", () => {
    expect(() => planChatSettings("claude", claude(), { effort: "low" }, false)).toThrow("too old");
  });

  it("lists the models when it offers none by that name", () => {
    expect(() => planChatSettings("claude", claude(), { model: "gpt" }, true)).toThrow(
      'it offers no model "gpt"; it offers default, haiku, sonnet',
    );
  });

  it("takes a mode in any case, and leaves the one that lets all run to the user", () => {
    expect(planChatSettings("claude", claude(), { mode: "acceptedits" }, true)).toEqual({
      mode: "acceptEdits",
    });
    expect(() => planChatSettings("claude", claude(), { mode: "bypassPermissions" }, true)).toThrow(
      "the user's to pick",
    );
    expect(() => planChatSettings("codex", claude(), { mode: "fullAccess" }, true)).toThrow(
      "the user's to pick",
    );
    expect(() => planChatSettings("codex", claude(), { mode: "plan" }, true)).toThrow(
      'no mode "plan"; the modes are readOnly, auto, fullAccess',
    );
  });

  it("lets the user pick that one from another device, unless a policy turned it off", () => {
    expect(planChatSettings("claude", claude(), { mode: "bypassPermissions" }, true, true)).toEqual(
      { mode: "bypassPermissions" },
    );
    const blocked = claude({ bypassBlocked: "disabled by your organization" });
    expect(() =>
      planChatSettings("claude", blocked, { mode: "bypassPermissions" }, true, true),
    ).toThrow("turned off here: disabled by your organization");
    expect(chatChoicesOf("claude", blocked).dangerousBlocked).toBe("disabled by your organization");
  });
});

describe("loosens", () => {
  it("tells a mode that lets more run unasked", () => {
    expect(loosens("claude", "plan", "acceptEdits")).toBe(true);
    expect(loosens("claude", "auto", "default")).toBe(false);
    expect(loosens("codex", "readOnly", "auto")).toBe(true);
    expect(loosens("codex", "auto", "auto")).toBe(false);
  });

  it("counts a mode it does not know as letting most run", () => {
    expect(loosens("claude", "someNewMode", "auto")).toBe(false);
    expect(loosens("claude", "default", "someNewMode")).toBe(true);
  });
});
