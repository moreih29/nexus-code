import { describe, expect, it } from "bun:test";
import {
  type ChatModel,
  emptyModel,
  type ModelInfo,
} from "../../../../../src/renderer/services/chat/model";
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

function withModels(models: ModelInfo[], model?: string): ChatModel {
  return { ...emptyModel(), model, init: { models, commands: [], remoteControl: false } };
}

const profileDefault = { profileDefault: "glm-5-plus" };
const customModels: ModelInfo[] = [
  {
    value: "default",
    displayName: "Default (recommended)",
    resolvedModel: "glm-5-plus[1m]",
  },
  { value: "glm-5-plus", displayName: "GLM 5 Plus", supportedEffortLevels: ["high"] },
  { value: "glm-5-air", displayName: "GLM 5 Air" },
];

describe("chatChoicesOf", () => {
  it("publishes the custom default by its visible model ID and label", () => {
    const model = withModels(customModels, "glm-5-plus[1m]");
    expect(chatChoicesOf("claude", model, profileDefault)).toMatchObject({
      model: "glm-5-plus",
      models: [
        { value: "glm-5-plus", name: "Default · GLM 5 Plus" },
        { value: "glm-5-air", name: "GLM 5 Air" },
      ],
      efforts: ["high"],
    });
  });

  it("retains the only default row if the profile's concrete model is missing", () => {
    const model = withModels([customModels[0]]);
    expect(chatChoicesOf("claude", model, profileDefault)).toMatchObject({
      model: "default",
      models: [{ value: "default", name: "Default · glm-5-plus" }],
    });
  });

  it("borrows models for an empty Claude list, then falls back to naming its current ID", () => {
    const model = withModels([], "claude-opus-5-5");
    const fallbackModels = [
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Profile Opus" },
    ];
    expect(chatChoicesOf("claude", model, { fallbackModels })).toMatchObject({
      model: "opus",
      models: [{ value: "opus", name: "Profile Opus" }],
    });
    expect(chatChoicesOf("claude", model)).toMatchObject({
      model: "claude-opus-5-5",
      models: [{ value: "claude-opus-5-5", name: "Opus 5.5" }],
      efforts: [],
    });
  });

  it("uses Codex's own model names, including the server's default model", () => {
    const model = withModels(
      [{ value: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }],
      "gpt-5.5",
    );
    expect(chatChoicesOf("codex", model)).toMatchObject({
      model: "gpt-5.5",
      models: [{ value: "gpt-5.5", name: "GPT-5.5" }],
    });
  });
});

describe("planChatSettings", () => {
  it("takes a model by its value, its name or the model it runs, in any case", () => {
    expect(planChatSettings("claude", claude(), { model: "Sonnet" }, true)).toEqual({
      model: "sonnet",
    });
    expect(planChatSettings("claude", claude(), { model: "claude-haiku-5-5" }, true)).toEqual({
      model: "haiku",
    });
  });

  it("takes the displayed profile default name and the hidden default's old names", () => {
    const model = withModels(customModels, "glm-5-air");
    for (const name of ["default · glm 5 plus", "GLM 5 Plus", "glm-5-plus"]) {
      expect(
        planChatSettings("claude", model, { model: name }, true, false, profileDefault),
      ).toEqual({ model: "glm-5-plus" });
    }
    for (const name of ["default", "Default (recommended)", "glm-5-plus[1m]"]) {
      expect(
        planChatSettings("claude", model, { model: name }, true, false, profileDefault),
      ).toEqual({ model: "default" });
    }
    expect(
      planChatSettings(
        "claude",
        withModels(customModels),
        { model: "Default (recommended)" },
        true,
        false,
        profileDefault,
      ),
    ).toEqual({});
  });

  it("accepts a fallback label for the current Claude model as a no-op", () => {
    const model = withModels([], "claude-opus-5-5");
    expect(planChatSettings("claude", model, { model: "opus 5.5" }, true)).toEqual({});
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
